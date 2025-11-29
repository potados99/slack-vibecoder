/**
 * Claude SDK 핸들러
 * 슬랙 메시지를 받아 Claude에 전달하고 응답을 스트리밍합니다.
 */

import { claude } from "@instantlyeasy/claude-code-sdk-ts";
import { sessionManager } from "./session-manager";
import { buildPrompt } from "./prompts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClaudeMessage = any;

interface ExecutionSummary {
  durationSeconds: number;
  toolCallCount: number;
}

interface StreamCallbacks {
  onProgress: (text: string, toolInfo: string | undefined, elapsedSeconds: number, toolCallCount: number) => Promise<void>;
  onResult: (text: string, summary: ExecutionSummary) => Promise<void>;
  onError: (error: Error) => Promise<void>;
}

/**
 * Claude에 쿼리를 보내고 스트리밍 응답을 처리합니다.
 */
export async function handleClaudeQuery(
  threadTs: string,
  userQuery: string,
  callbacks: StreamCallbacks,
  channelId?: string
): Promise<string | null> {
  const session = sessionManager.getOrCreateSession(threadTs);
  const abortSignal = session.abortController.signal;

  let progressText = "";
  let resultText = "";
  let currentToolInfo = "";
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL = 500; // 500ms마다 업데이트

  // 실행 통계
  const startTime = Date.now();
  let toolCallCount = 0;

  try {
    let claudeBuilder = claude()
      .skipPermissions()
      .withSignal(abortSignal)
      .onToolUse((tool) => {
        toolCallCount++;

        const input = tool.input as Record<string, unknown> | undefined;
        const description = input?.description as string || "";
        const command = input?.command as string || "";
        const pattern = input?.pattern as string || "";
        const filePath = input?.file_path as string || "";

        // 도구별 상세 정보 구성
        let details = "";
        if (description) details += description;
        if (command) details += (details ? "\n" : "") + `\`${command}\``;
        if (pattern) details += (details ? "\n" : "") + `패턴: ${pattern}`;
        if (filePath) details += (details ? "\n" : "") + `파일: ${filePath}`;

        currentToolInfo = `🔧 *${tool.name}*${details ? "\n" + details : ""}`;
      });

    // 기존 세션이 있으면 이어서 대화
    if (session.claudeSessionId) {
      claudeBuilder = claudeBuilder.withSessionId(session.claudeSessionId);
    }

    const prompt = buildPrompt(userQuery, threadTs, channelId);

    await claudeBuilder.query(prompt).stream(async (message: ClaudeMessage) => {
      // 중단 체크
      if (abortSignal.aborted) {
        return;
      }

      // assistant 메시지에서 텍스트 추출
      if (
        message.type === "assistant" &&
        message.content &&
        message.content.length > 0
      ) {
        const textContent = message.content.find(
          (c: { type: string; text?: string }) => c.type === "text"
        );
        if (textContent && textContent.text) {
          progressText = textContent.text;

          // 스로틀링: 너무 자주 업데이트하지 않음
          const now = Date.now();
          if (now - lastUpdateTime > UPDATE_INTERVAL) {
            lastUpdateTime = now;
            const elapsedSeconds = Math.round((now - startTime) / 1000);
            await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
          }
        }
      }

      // result 메시지 처리
      if (message.type === "result") {
        resultText = message.result || progressText;
      }
    });

    // 최종 결과 전송
    const finalText = resultText || progressText;
    if (finalText && !abortSignal.aborted) {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      await callbacks.onResult(finalText, { durationSeconds, toolCallCount });
    }

    // 세션 ID 업데이트 (첫 번째 쿼리 후)
    // Note: SDK에서 세션 ID를 가져오는 방법이 있다면 여기서 업데이트
    // 현재 SDK 구조상 세션 ID는 내부적으로 관리되므로 스킵

    return finalText;
  } catch (error) {
    if (abortSignal.aborted) {
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      await callbacks.onProgress("⏹️ 작업이 중단되었습니다.", undefined, elapsedSeconds, toolCallCount);
      return null;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    await callbacks.onError(err);
    throw err;
  }
}

/**
 * 세션을 중단합니다.
 */
export function abortSession(threadTs: string): boolean {
  return sessionManager.abortSession(threadTs);
}
