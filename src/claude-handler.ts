/**
 * Claude SDK 핸들러
 * 슬랙 메시지를 받아 Claude에 전달하고 응답을 스트리밍합니다.
 */

import { claude, type Message, type ContentBlock } from "@instantlyeasy/claude-code-sdk-ts";
import { sessionManager } from "./session-manager";
import { buildPrompt } from "./prompts";

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
  channelId?: string,
  responseTs?: string,
  isInThread?: boolean
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
      .onToolUse(async (tool) => {
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
        
        // 즉시 UI 업데이트 (툴 실행 정보를 실시간으로 보여주기)
        const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
        await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
      });

    // 기존 세션이 있으면 이어서 대화
    if (session.claudeSessionId) {
      console.log(`[${new Date().toISOString()}] 🔄 기존 세션 ID 사용: ${session.claudeSessionId.substring(0, 12)}... (스레드: ${threadTs})`);
      claudeBuilder = claudeBuilder.withSessionId(session.claudeSessionId);
    } else {
      console.log(`[${new Date().toISOString()}] 🆕 새 세션 시작 (스레드: ${threadTs})`);
    }

    const prompt = buildPrompt(userQuery, threadTs, channelId, responseTs, isInThread);

    await claudeBuilder.query(prompt).stream(async (message: Message) => {
      // 중단 체크
      if (abortSignal.aborted) {
        return;
      }

      // 세션 ID는 모든 메시지에서 올 수 있으므로 항상 확인
      if (message.session_id && !session.claudeSessionId) {
        console.log(`[${new Date().toISOString()}] 📌 세션 ID 저장: ${message.session_id.substring(0, 12)}... (스레드: ${threadTs})`);
        sessionManager.updateClaudeSessionId(threadTs, message.session_id);
      }

      // assistant 메시지에서 텍스트 추출
      if (message.type === "assistant") {
        const textContent = message.content.find(
          (c: ContentBlock): c is ContentBlock & { type: 'text'; text: string } => c.type === "text"
        );
        if (textContent) {
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
        resultText = message.content || progressText;
      }
    });

    // 스트림 종료 후 디바운스로 스킵된 마지막 상태가 있으면 강제 전달
    if (!abortSignal.aborted && progressText) {
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
    }

    // 최종 결과 전송 (빈 텍스트라도 무조건 호출하여 UI 정리)
    if (!abortSignal.aborted) {
      const finalText = resultText || progressText;
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      await callbacks.onResult(finalText, { durationSeconds, toolCallCount });
    }

    return resultText || progressText;
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
