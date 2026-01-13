/**
 * 슬랙 응답 핸들러
 *
 * 세션 상태, 타이머, 메시지 업데이트를 관리.
 * app.ts에서 복잡한 콜백/타이머 로직을 분리하여 가독성 향상.
 */

import {
  buildAbortedMessage,
  buildErrorMessage,
  buildProgressMessage,
  buildResultMessage,
  buildTextBlock,
  buildThinkingMessage,
  formatDuration,
  getUserMention,
} from "./slack-message";

type SlackBlock = Record<string, unknown>;

// Slack client 타입 (chat.postMessage, chat.update 메서드만 사용)
interface SlackClient {
  chat: {
    postMessage: (args: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: SlackBlock[];
    }) => Promise<{ ts?: string }>;
    update: (args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: SlackBlock[];
    }) => Promise<unknown>;
  };
}

/**
 * 응답 핸들러 클래스
 *
 * 하나의 요청-응답 사이클을 관리.
 * - 초기 메시지 전송
 * - 타이머로 메타데이터 갱신
 * - onProgress/onResult/onError 콜백
 * - race condition 방지
 */
export class ResponseHandler {
  private readonly client: SlackClient;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly userId: string;

  private responseTs: string | null = null;
  private timerId: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();

  // 마지막 메시지 상태 (idempotent 업데이트용)
  private lastBlocks: SlackBlock[] = [];
  private lastFallbackText: string = "";

  // race condition 방지 플래그
  private isCompleted: boolean = false;

  constructor(client: SlackClient, channel: string, threadTs: string, userId: string) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
    this.userId = userId;
  }

  /**
   * 초기 "생각하는 중..." 메시지를 전송하고 타이머를 시작합니다.
   * 반환값: 메시지 타임스탬프 (실패 시 null)
   */
  async start(): Promise<string | null> {
    this.startTime = Date.now();

    const { blocks, fallbackText } = buildThinkingMessage(this.userId, this.threadTs);
    this.lastBlocks = blocks;
    this.lastFallbackText = fallbackText;

    const response = await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: fallbackText,
      blocks,
    });

    if (!response.ts) {
      console.error("응답 메시지 타임스탬프를 가져올 수 없습니다.");
      return null;
    }

    this.responseTs = response.ts;

    // 매초 메타데이터 업데이트 타이머 시작
    this.timerId = setInterval(() => this.updateMetadataOnly(), 1000);

    return this.responseTs;
  }

  /**
   * 기존 메시지를 업데이트하여 "생각하는 중..." 상태로 시작합니다.
   * 큐에서 처리할 때 사용합니다.
   * 반환값: 메시지 타임스탬프 (실패 시 null)
   */
  async startWithExistingMessage(existingTs: string): Promise<string | null> {
    this.startTime = Date.now();
    this.responseTs = existingTs;

    const { blocks, fallbackText } = buildThinkingMessage(this.userId, this.threadTs);
    this.lastBlocks = blocks;
    this.lastFallbackText = fallbackText;

    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: existingTs,
        text: fallbackText,
        blocks,
      });
    } catch (error) {
      console.error("기존 메시지 업데이트 실패:", error);
      return null;
    }

    // 매초 메타데이터 업데이트 타이머 시작
    this.timerId = setInterval(() => this.updateMetadataOnly(), 1000);

    return this.responseTs;
  }

  /**
   * 진행 상황을 업데이트합니다. (onProgress 콜백용)
   */
  async updateProgress(
    text: string,
    toolInfo: string | undefined,
    elapsedSeconds: number,
    toolCallCount: number,
  ): Promise<void> {
    if (!this.responseTs || this.isCompleted) {
      return;
    }

    const { blocks, fallbackText } = buildProgressMessage(
      this.userId,
      this.threadTs,
      text,
      toolInfo,
      elapsedSeconds,
      toolCallCount,
    );

    this.lastBlocks = blocks;
    this.lastFallbackText = fallbackText;

    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.responseTs,
        text: fallbackText,
        blocks,
      });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] onProgress chat.update 실패:`, error);
    }
  }

  /**
   * 최종 결과를 표시합니다. (onResult 콜백용)
   */
  async showResult(text: string, durationSeconds: number, toolCallCount: number): Promise<void> {
    // race condition 방지
    this.isCompleted = true;
    this.stopTimer();

    if (!this.responseTs) {
      return;
    }

    const { firstMessage, additionalChunks } = buildResultMessage(
      this.userId,
      text,
      durationSeconds,
      toolCallCount,
    );

    this.lastBlocks = firstMessage.blocks;
    this.lastFallbackText = firstMessage.fallbackText;

    // 에러 표시 헬퍼
    const showError = async (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const { blocks, fallbackText } = buildErrorMessage(this.userId, errorMessage);

      try {
        await this.client.chat.update({
          channel: this.channel,
          ts: this.responseTs!,
          text: fallbackText,
          blocks,
        });
      } catch {
        console.error(`[${new Date().toISOString()}] 에러 표시도 실패`);
      }
    };

    // 첫 번째 청크: 기존 메시지 업데이트
    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.responseTs,
        text: firstMessage.fallbackText,
        blocks: firstMessage.blocks,
      });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] onResult 첫 메시지 업데이트 실패:`, error);
      await showError(error);
      return;
    }

    // 나머지 청크: 스레드에 추가 메시지로 전송
    for (let i = 0; i < additionalChunks.length; i++) {
      try {
        await this.client.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text: additionalChunks[i],
          blocks: [buildTextBlock(additionalChunks[i])],
        });
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] 후속 메시지 ${i + 2}/${additionalChunks.length + 1} 전송 실패:`,
          error,
        );
        await showError(error);
        return;
      }
    }

    // Quick fix: 1초 후에 첫 메시지 한 번 더 업데이트 (race condition 방지)
    setTimeout(async () => {
      try {
        await this.client.chat.update({
          channel: this.channel,
          ts: this.responseTs!,
          text: firstMessage.fallbackText,
          blocks: firstMessage.blocks,
        });
      } catch {
        // 재시도 실패는 무시
      }
    }, 1000);

    const timeStr = formatDuration(durationSeconds);
    console.log(
      `[${new Date().toISOString()}] ✅ TURNAROUND_SUCCESS: 스레드 ${this.threadTs} 완료 (${timeStr}, 도구 ${toolCallCount}회, ${additionalChunks.length + 1}개 메시지)`,
    );
  }

  /**
   * 에러를 표시합니다. (onError 콜백용)
   */
  async showError(error: Error): Promise<void> {
    this.isCompleted = true;
    this.stopTimer();

    if (!this.responseTs) {
      return;
    }

    const { blocks, fallbackText } = buildErrorMessage(this.userId, error.message);
    this.lastBlocks = blocks;
    this.lastFallbackText = fallbackText;

    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.responseTs,
        text: fallbackText,
        blocks,
      });
    } catch (updateError) {
      console.error(`[${new Date().toISOString()}] onError chat.update 실패:`, updateError);

      // 최소한의 메시지라도 시도
      try {
        await this.client.chat.update({
          channel: this.channel,
          ts: this.responseTs,
          text: `${getUserMention(this.userId)} 오류 발생 (상세 표시 실패)`.trim(),
          blocks: [],
        });
      } catch (retryError) {
        console.error(`[${new Date().toISOString()}] 최소 에러 메시지 표시도 실패:`, retryError);
      }
    }
  }

  /**
   * 작업 중단을 표시합니다.
   */
  async showAborted(): Promise<void> {
    this.stopTimer();

    if (!this.responseTs) {
      return;
    }

    const { blocks, fallbackText } = buildAbortedMessage(this.userId);

    await this.client.chat.update({
      channel: this.channel,
      ts: this.responseTs,
      text: fallbackText,
      blocks,
    });
  }

  /**
   * 타이머를 정지합니다.
   */
  stopTimer(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * 응답 메시지 타임스탬프를 반환합니다.
   */
  getResponseTs(): string | null {
    return this.responseTs;
  }

  /**
   * 완료 여부를 반환합니다.
   */
  getIsCompleted(): boolean {
    return this.isCompleted;
  }

  // ============================================================================
  // Private
  // ============================================================================

  /**
   * 메타데이터(시간)만 업데이트합니다. (타이머 콜백용)
   *
   * idempotent 설계: 마지막으로 보낸 블록을 그대로 사용하되
   * context 블록의 시간 부분만 현재 시간으로 교체.
   */
  private async updateMetadataOnly(): Promise<void> {
    if (!this.responseTs || this.lastBlocks.length === 0) {
      return;
    }

    // 이미 완료된 세션이면 업데이트하지 않음
    if (this.isCompleted) {
      return;
    }

    // 현재 경과 시간 계산
    const elapsedSeconds = Math.round((Date.now() - this.startTime) / 1000);
    const timeStr = formatDuration(elapsedSeconds);

    // 마지막 블록을 깊은 복사
    const updatedBlocks = JSON.parse(JSON.stringify(this.lastBlocks));

    // context 블록 찾아서 시간 부분만 교체
    for (const block of updatedBlocks) {
      if (block.type === "context" && Array.isArray(block.elements)) {
        for (const element of block.elements) {
          if (element.type === "mrkdwn" && typeof element.text === "string") {
            // 시간 패턴: _X초 또는 _X분 Y초 로 시작하는 부분을 교체
            element.text = element.text.replace(
              /^_\d+분?\s*\d*초?\s*(경과|소요)/,
              `_${timeStr} $1`,
            );
          }
        }
      }
    }

    // 2차 체크: 블록 준비 후, chat.update 직전에 다시 확인
    if (this.isCompleted) {
      return;
    }

    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.responseTs,
        text: this.lastFallbackText,
        blocks: updatedBlocks,
      });
    } catch (error) {
      console.warn(`메타데이터 업데이트 실패 (스레드: ${this.threadTs}):`, error);
      this.stopTimer();
    }
  }
}
