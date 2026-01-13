/**
 * Slack Vibecoder - Claude를 활용한 슬랙 봇
 *
 * 기능:
 * - 멘션을 받으면 Claude가 작업 시작
 * - 스레드 기반 세션 관리
 * - 진행 상황 실시간 업데이트
 * - "멈춰!" 버튼으로 작업 중단
 * - 큐잉 시스템: 처리 중 새 요청은 큐에 대기
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, type BlockAction, type ButtonAction } from "@slack/bolt";
import { setAppStartCommitHash, setAppVersion } from "./app-info";
import { abortSession, handleClaudeQuery } from "./claude-handler";
import { ResponseHandler } from "./response-handler";
import { sessionManager } from "./session-manager";
import { buildCancelledMessage, buildQueuedMessage, getUserMention } from "./slack-message";
import { generateMessageId, type QueuedMessage, threadQueueManager } from "./thread-queue";

// 환경 변수 확인
const requiredEnvVars = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "CLAUDE_CWD"];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ 환경 변수 ${envVar}가 설정되지 않았습니다.`);
    process.exit(1);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ============================================================================
// 이벤트 핸들러
// ============================================================================

/**
 * 멘션 이벤트 핸들러
 */
app.event("app_mention", async ({ event, client, say }) => {
  const userId = event.user ?? "unknown";
  const channel = event.channel;

  // 세션 키: 항상 사용자 메시지가 스레드 루트
  const threadTs = event.thread_ts ?? event.ts;

  // 멘션에서 봇 태그 제거하고 실제 메시지 추출
  const botMentionRegex = /<@[A-Z0-9]+>/g;
  const userQuery = event.text.replace(botMentionRegex, "").trim();

  if (!userQuery) {
    await say({
      text: `${getUserMention(userId)} 무엇을 도와드릴까요? 메시지를 함께 보내주세요!`.trim(),
      thread_ts: threadTs,
    });
    return;
  }

  console.log(`[${new Date().toISOString()}] 📩 멘션 수신: ${userQuery} (스레드: ${threadTs})`);

  // 이미 처리 중인지 확인
  if (threadQueueManager.isProcessing(threadTs)) {
    // 큐잉 메시지 전송
    const messageId = generateMessageId();
    const queuePosition = threadQueueManager.getQueueLength(threadTs) + 1;

    const { blocks, fallbackText } = buildQueuedMessage(userId, threadTs, messageId, queuePosition);

    const response = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: fallbackText,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: blocks as any,
    });

    if (response.ts) {
      const queuedMessage: QueuedMessage = {
        id: messageId,
        userQuery,
        userId,
        channel,
        responseTs: response.ts,
        queuedAt: new Date(),
        status: "queued",
      };
      threadQueueManager.enqueue(threadTs, queuedMessage);
      console.log(
        `[${new Date().toISOString()}] 📋 큐잉됨: ${messageId} (스레드: ${threadTs}, 위치: ${queuePosition})`,
      );
    }
    return;
  }

  // 바로 처리 시작
  await startProcessing(client, channel, threadTs, userId, userQuery, generateMessageId());
});

/**
 * 메시지 처리를 시작합니다.
 *
 * 응답 핸들러를 생성하고 Claude를 호출합니다.
 * 완료 후 큐에 다음 메시지가 있으면 자동으로 처리합니다.
 */
async function startProcessing(
  client: typeof app.client,
  channel: string,
  threadTs: string,
  userId: string,
  userQuery: string,
  messageId: string,
  existingResponseTs?: string,
): Promise<void> {
  const handler = new ResponseHandler(client, channel, threadTs, userId);

  // tryStartProcessing으로 atomic하게 시작
  if (!threadQueueManager.tryStartProcessing(threadTs, handler, messageId)) {
    // 이미 처리 중 (경쟁 상태에서 다른 곳에서 시작됨)
    console.warn(`[${new Date().toISOString()}] ⚠️ 이미 처리 중 (스레드: ${threadTs})`);
    return;
  }

  // 응답 메시지 생성 또는 기존 메시지 재사용
  let responseTs: string | null;
  if (existingResponseTs) {
    // 큐에서 온 경우: 기존 큐잉 메시지를 업데이트
    responseTs = await handler.startWithExistingMessage(existingResponseTs);
  } else {
    // 새 요청: 새 메시지 생성
    responseTs = await handler.start();
  }

  if (!responseTs) {
    threadQueueManager.finishProcessing(threadTs);
    return;
  }

  console.log(`[${new Date().toISOString()}] 🤖 처리 시작: ${messageId} (스레드: ${threadTs})`);

  try {
    await handleClaudeQuery(
      threadTs,
      userQuery,
      {
        onProgress: async (text, toolInfo, elapsedSeconds, toolCallCount) => {
          // 현재 핸들러가 아니면 업데이트 스킵
          if (threadQueueManager.getCurrentMessageId(threadTs) !== messageId) {
            return;
          }
          await handler.updateProgress(text, toolInfo, elapsedSeconds, toolCallCount);
        },

        onResult: async (text, summary) => {
          await handler.showResult(text, summary.durationSeconds, summary.toolCallCount);
          processNextInQueue(client, threadTs);
        },

        onError: async (error) => {
          await handler.showError(error);
          processNextInQueue(client, threadTs);
        },
      },
      channel,
    );
  } catch (error) {
    console.error("Claude 처리 중 오류:", error);
    handler.stopTimer();
    processNextInQueue(client, threadTs);
  }
}

/**
 * 큐에서 다음 메시지를 처리합니다.
 */
function processNextInQueue(client: typeof app.client, threadTs: string): void {
  const nextMessage = threadQueueManager.finishProcessing(threadTs);

  if (nextMessage) {
    console.log(
      `[${new Date().toISOString()}] 📤 큐에서 다음 처리: ${nextMessage.id} (스레드: ${threadTs})`,
    );

    // 비동기로 다음 메시지 처리 시작
    startProcessing(
      client,
      nextMessage.channel,
      threadTs,
      nextMessage.userId,
      nextMessage.userQuery,
      nextMessage.id,
      nextMessage.responseTs,
    ).catch((error) => {
      console.error("큐 처리 중 오류:", error);
    });
  }
}

/**
 * "멈춰!" 버튼 액션 핸들러
 */
app.action<BlockAction<ButtonAction>>("stop_claude", async ({ body, ack }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const threadTs = action.value;
  const channel = body.channel?.id;

  if (!channel || !threadTs) {
    console.error("채널 또는 스레드 정보 없음");
    return;
  }

  console.log(`🛑 중단 요청: 스레드 ${threadTs}`);

  const handler = threadQueueManager.getCurrentHandler(threadTs);

  // 세션 중단
  const aborted = abortSession(threadTs);

  if (aborted && handler) {
    await handler.showAborted();
    // 큐에서 다음 메시지 처리
    processNextInQueue(app.client, threadTs);
  }
});

/**
 * "즉시 처리" 버튼 액션 핸들러
 */
app.action<BlockAction<ButtonAction>>("process_now", async ({ body, ack, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const channel = body.channel?.id;

  if (!channel || !action.value) {
    console.error("채널 또는 액션 값 없음");
    return;
  }

  let threadTs: string;
  let messageId: string;
  try {
    const parsed = JSON.parse(action.value);
    threadTs = parsed.threadTs;
    messageId = parsed.messageId;
  } catch {
    console.error("액션 값 파싱 실패:", action.value);
    return;
  }

  console.log(`⚡ 즉시 처리 요청: ${messageId} (스레드: ${threadTs})`);

  // 큐에서 해당 메시지 추출
  const message = threadQueueManager.prioritize(threadTs, messageId);
  if (!message) {
    console.warn("큐에서 메시지를 찾을 수 없음:", messageId);
    return;
  }

  // 현재 처리 중인 핸들러가 있으면 중단
  const currentHandler = threadQueueManager.getCurrentHandler(threadTs);
  if (currentHandler) {
    abortSession(threadTs);
    await currentHandler.showAborted();
    threadQueueManager.finishProcessing(threadTs);
  }

  // 해당 메시지 즉시 처리 시작
  await startProcessing(
    client,
    message.channel,
    threadTs,
    message.userId,
    message.userQuery,
    message.id,
    message.responseTs,
  );
});

/**
 * "취소" 버튼 액션 핸들러
 */
app.action<BlockAction<ButtonAction>>("cancel_queued", async ({ body, ack, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const channel = body.channel?.id;

  if (!channel || !action.value) {
    console.error("채널 또는 액션 값 없음");
    return;
  }

  let threadTs: string;
  let messageId: string;
  try {
    const parsed = JSON.parse(action.value);
    threadTs = parsed.threadTs;
    messageId = parsed.messageId;
  } catch {
    console.error("액션 값 파싱 실패:", action.value);
    return;
  }

  console.log(`❌ 취소 요청: ${messageId} (스레드: ${threadTs})`);

  // 취소할 메시지 조회
  const message = threadQueueManager.getQueuedMessage(threadTs, messageId);
  if (!message) {
    console.warn("큐에서 메시지를 찾을 수 없음:", messageId);
    return;
  }

  // 큐에서 취소
  const cancelled = threadQueueManager.cancelQueued(threadTs, messageId);
  if (!cancelled) {
    console.warn("메시지 취소 실패:", messageId);
    return;
  }

  // 메시지 업데이트
  const { blocks, fallbackText } = buildCancelledMessage(message.userId);
  try {
    await client.chat.update({
      channel,
      ts: message.responseTs,
      text: fallbackText,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: blocks as any,
    });
  } catch (error) {
    console.error("취소 메시지 업데이트 실패:", error);
  }
});

// ============================================================================
// 주기적 정리
// ============================================================================

// 오래된 세션 및 큐 정리 (30분마다)
setInterval(
  () => {
    sessionManager.cleanupOldSessions(60 * 60 * 1000); // 1시간 이상된 세션 정리
    threadQueueManager.cleanupOldThreads(60 * 60 * 1000); // 1시간 이상된 큐 정리
  },
  30 * 60 * 1000,
);

// ============================================================================
// 앱 시작
// ============================================================================

(async () => {
  const projectDir = process.env.PROJECT_DIR || process.cwd();

  // 앱 시작 시점의 커밋 해시 저장
  try {
    const commitHash = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();
    setAppStartCommitHash(commitHash);
    console.log(`📌 앱 시작 시점 커밋 해시: ${commitHash}`);
  } catch (error) {
    console.warn("⚠️ 커밋 해시를 가져오지 못했습니다:", error);
  }

  // 앱 버전 저장
  try {
    const packageJsonPath = join(projectDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (packageJson.version) {
      setAppVersion(packageJson.version);
      console.log(`📦 앱 버전: v${packageJson.version}`);
    }
  } catch (error) {
    console.warn("⚠️ 버전을 가져오지 못했습니다:", error);
  }

  const port = parseInt(process.env.PORT || "3000", 10);
  await app.start(port);

  // 온라인 상태로 설정
  await app.client.users.setPresence({ presence: "auto" });

  console.log(`⚡️ Slack Vibecoder가 시작되었습니다! (포트: ${port})`);
  console.log("🤖 Socket Mode로 연결되었습니다.");
})();
