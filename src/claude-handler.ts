/**
 * Claude SDK 핸들러
 * 슬랙 메시지를 받아 Claude에 전달하고 응답을 스트리밍합니다.
 */

import { claude, type Message, type ContentBlock } from "@instantlyeasy/claude-code-sdk-ts";
import { sessionManager } from "./session-manager";
import { buildPrompt } from "./prompts";

/** 실행 요약 정보입니다. */
interface ExecutionSummary {
  durationSeconds: number;
  toolCallCount: number;
}

/** 스트림 콜백 인터페이스입니다. */
interface StreamCallbacks {
  /** 진행 상황이 업데이트될 때 호출됩니다. */
  onProgress: (text: string, toolInfo: string | undefined, elapsedSeconds: number, toolCallCount: number) => Promise<void>;
  /** 최종 결과가 도착했을 때 호출됩니다. */
  onResult: (text: string, summary: ExecutionSummary) => Promise<void>;
  /** 에러가 발생했을 때 호출됩니다. */
  onError: (error: Error) => Promise<void>;
}

/**
 * Claude에 쿼리를 보내고 스트리밍 응답을 처리합니다.
 *
 * 흐름:
 * 1. 도구 사용 시 → onProgress 호출
 * 2. 어시스턴트 텍스트 수신 시 → onProgress 호출
 * 3. 스트림 종료 시 → onResult 호출 (최종 상태)
 */
export async function handleClaudeQuery(
  threadTs: string,
  userQuery: string,
  callbacks: StreamCallbacks,
  channelId?: string
): Promise<string | null> {
  const session = sessionManager.getOrCreateSession(threadTs);
  const abortSignal = session.abortController.signal;

  // 상태 변수들
  let progressText = "";      // 현재까지 받은 텍스트
  let resultText = "";        // 최종 결과 텍스트
  let currentToolInfo = "";   // 현재 실행 중인 도구 정보

  // 실행 통계
  const startTime = Date.now();
  let toolCallCount = 0;

  try {
    let claudeBuilder = claude()
      .withConfig({
        version: "1.0", 
        globalSettings: {
          cwd: process.env.CLAUDE_CWD,
          permissionMode: "bypassPermissions"
        }
      })
      .withSignal(abortSignal)
      
      // 도구 사용 시 즉시 UI 업데이트합니다.
      .onToolUse(async (tool) => {
        toolCallCount++;

        // 도구 입력에서 상세 정보를 추출합니다.
        const input = tool.input as Record<string, unknown> | undefined;
        const description = input?.description as string || "";
        const command = input?.command as string || "";
        const pattern = input?.pattern as string || "";
        const filePath = input?.file_path as string || "";

        // 도구별 상세 정보를 구성합니다.
        let details = "";
        if (description) details += description;
        if (command) details += (details ? "\n" : "") + `\`${command}\``;
        if (pattern) details += (details ? "\n" : "") + `패턴: ${pattern}`;
        if (filePath) details += (details ? "\n" : "") + `파일: ${filePath}`;

        currentToolInfo = `🔧 *${tool.name}*${details ? "\n" + details : ""}`;

        // 도구 사용은 중요한 이벤트이므로 즉시 UI에 반영합니다.
        const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
        await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
      })

      // 어시스턴트 메시지를 처리합니다.
      .onAssistant(async (content) => {
        if (abortSignal.aborted) return;

        // 텍스트 콘텐츠를 찾습니다.
        const textContent = content.find(
          (c: ContentBlock): c is ContentBlock & { type: 'text'; text: string } => c.type === "text"
        );

        if (textContent) {
          progressText = textContent.text;

          // 텍스트가 업데이트되면 UI에 반영합니다.
          const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
          await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
        }
      })

      // 모든 메시지에서 세션 ID와 결과를 처리합니다.
      .onMessage((message) => {
        if (abortSignal.aborted) return;

        // 세션 ID를 저장합니다 (첫 번째 수신 시에만).
        if (message.session_id && !session.claudeSessionId) {
          console.log(`[${new Date().toISOString()}] 📌 세션 ID 저장: ${message.session_id.substring(0, 12)}... (스레드: ${threadTs})`);
          sessionManager.updateClaudeSessionId(threadTs, message.session_id);
        }

        // result 메시지가 오면 최종 텍스트를 저장합니다.
        if (message.type === "result") {
          resultText = message.content || progressText;
        }
      });

    // 기존 세션이 있으면 이어서 대화합니다.
    if (session.claudeSessionId) {
      console.log(`[${new Date().toISOString()}] 🔄 기존 세션 ID 사용: ${session.claudeSessionId.substring(0, 12)}... (스레드: ${threadTs})`);
      claudeBuilder = claudeBuilder.withSessionId(session.claudeSessionId);
    } else {
      console.log(`[${new Date().toISOString()}] 🆕 새 세션 시작 (스레드: ${threadTs})`);
    }

    const prompt = buildPrompt(userQuery, threadTs, channelId);

    // 스트림을 실행합니다. 콜백들이 자동으로 호출됩니다.
    await claudeBuilder.query(prompt).stream(async () => {
      // 스트림 메시지는 위의 콜백들에서 처리됩니다.
    });

    // 스트림이 종료되면 최종 결과를 전송합니다.
    // 중요: onProgress를 여기서 호출하지 않습니다. 경합 조건을 방지하기 위함입니다.
    if (!abortSignal.aborted) {
      const finalText = resultText || progressText;
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      await callbacks.onResult(finalText, { durationSeconds, toolCallCount });
    }

    return resultText || progressText;
  } catch (error) {
    if (abortSignal.aborted) {
      // 중단 시에는 아무것도 하지 않습니다.
      // stop_claude 액션에서 이미 UI를 업데이트했습니다.
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
