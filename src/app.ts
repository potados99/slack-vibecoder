/**
 * Slack Vibecoder - Claude를 활용한 슬랙 봇
 *
 * 기능:
 * - 멘션을 받으면 Claude가 작업 시작
 * - 스레드 기반 세션 관리
 * - 진행 상황 실시간 업데이트
 * - "멈춰!" 버튼으로 작업 중단
 */

import "dotenv/config";
import { App, BlockAction, ButtonAction } from "@slack/bolt";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { handleClaudeQuery, abortSession } from "./claude-handler";
import { sessionManager } from "./session-manager";
import { setAppStartCommitHash, setAppVersion, getAppVersion, getAppStartCommitHash } from "./app-info";

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

// 진행 중인 메시지 추적 (channel:ts -> message_ts)
const activeMessages = new Map<string, string>();

// 세션별 메타데이터 업데이트 타이머 및 상태 추적
interface SessionState {
  startTime: number;
  timerId: NodeJS.Timeout | null;
  channel: string;
  responseTs: string; // 항상 존재함 (초기화 시 체크함)
  userId: string;
  lastBlocks: Array<Record<string, unknown>>; // 마지막으로 보낸 블록들 (idempotent 업데이트용)
  lastFallbackText: string; // 마지막으로 보낸 fallback 텍스트
}

const sessionStates = new Map<string, SessionState>();

/**
 * 슬랙 블록 텍스트를 안전한 길이로 자릅니다.
 * 슬랙 mrkdwn 텍스트 블록 제한: 3000자
 * 여유를 두고 2500자로 제한 (메타데이터, 태그 등 고려)
 */
function truncateForSlack(text: string, maxLength: number = 2500): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}

/**
 * 메타데이터(시간)만 업데이트하는 함수 (타이머용)
 *
 * idempotent 설계: 마지막으로 보낸 블록을 그대로 사용하되
 * context 블록의 시간 부분만 현재 시간으로 교체합니다.
 * 이렇게 하면 진행 중이든 완료 후든 언제 호출해도 안전합니다.
 */
async function updateMetadataOnly(threadTs: string): Promise<void> {
  const state = sessionStates.get(threadTs);
  if (!state || !state.responseTs || !state.lastBlocks || state.lastBlocks.length === 0) return;

  // 현재 경과 시간 계산
  const elapsedSeconds = Math.round((Date.now() - state.startTime) / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const timeStr = minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;

  // 마지막 블록을 깊은 복사
  const updatedBlocks = JSON.parse(JSON.stringify(state.lastBlocks));

  // context 블록 찾아서 시간 부분만 교체
  for (const block of updatedBlocks) {
    if (block.type === "context" && Array.isArray(block.elements)) {
      for (const element of block.elements) {
        if (element.type === "mrkdwn" && typeof element.text === "string") {
          // 시간 패턴: _X초 또는 _X분 Y초 로 시작하는 부분을 교체
          // 예: "_10초 경과, ..." 또는 "_2분 15초 소요, ..."
          element.text = element.text.replace(
            /^_\d+분?\s*\d*초?\s*(경과|소요)/,
            `_${timeStr} $1`
          );
        }
      }
    }
  }

  try {
    await app.client.chat.update({
      channel: state.channel,
      ts: state.responseTs,
      text: state.lastFallbackText,
      blocks: updatedBlocks,
    });
  } catch (error) {
    // 업데이트 실패 시 타이머 정리
    console.warn(`메타데이터 업데이트 실패 (스레드: ${threadTs}):`, error);
    const sessionState = sessionStates.get(threadTs);
    if (sessionState?.timerId) {
      clearInterval(sessionState.timerId);
      sessionState.timerId = null;
    }
  }
}

/**
 * 멘션 이벤트 핸들러
 */
app.event("app_mention", async ({ event, client, say }) => {
  const userId = event.user ?? "unknown";
  const channel = event.channel;
  const messageTs = event.ts;
  // 스레드 안에서 멘션한 경우에만 스레드로 답장, 아니면 채널에 직접 답장
  const isInThread = !!event.thread_ts;

  // 멘션에서 봇 태그 제거하고 실제 메시지 추출
  const botMentionRegex = /<@[A-Z0-9]+>/g;
  const userQuery = event.text.replace(botMentionRegex, "").trim();

  if (!userQuery) {
    await say({
      text: `<@${userId}> 무엇을 도와드릴까요? 메시지를 함께 보내주세요!`,
      ...(isInThread && { thread_ts: event.thread_ts }),
    });
    return;
  }

  console.log(`[${new Date().toISOString()}] 📩 멘션 수신: ${userQuery} (채널 루트 요청: ${!isInThread})`);

  // 메타데이터 구성
  const version = getAppVersion();
  const commitHash = getAppStartCommitHash();
  const versionInfoParts: string[] = [];
  
  if (version) {
    versionInfoParts.push(`v${version}`);
  }
  if (commitHash) {
    versionInfoParts.push(`(${commitHash.substring(0, 7)})`);
  }
  
  const versionInfo = versionInfoParts.length > 0 ? `, ${versionInfoParts.join(" ")}` : "";
  const initialMetadataText = `_0초 경과, 도구 0회 호출${versionInfo}_`;

  // 세션 키 결정: 스레드 루트가 세션 키
  // - 스레드 내 요청: 스레드 루트 (event.thread_ts)
  // - 채널 루트 요청: 봇의 첫 응답이 스레드 루트가 됨 (아직 생성 전)
  let threadTs: string;
  
  if (isInThread) {
    // 스레드 내 요청: 기존 스레드 루트 사용
    threadTs = event.thread_ts!;
    console.log(`[${new Date().toISOString()}] 🔗 스레드 내 요청, 세션 키: ${threadTs}`);
  } else {
    // 채널 루트 요청: 임시 세션 키 사용 (responseTs가 확정되면 세션 이동)
    threadTs = `temp_${messageTs}`;
    console.log(`[${new Date().toISOString()}] 🆕 채널 루트 요청, 임시 세션 키: ${threadTs}`);
  }

  // 초기 메시지 블록 구성
  const initialBlocks = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: initialMetadataText,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<@${userId}> 🤔 생각하는 중...`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "🛑 멈춰!",
            emoji: true,
          },
          action_id: "stop_claude",
          value: threadTs,
        },
      ],
    },
  ];

  const initialFallbackText = `<@${userId}> 🤔 생각하는 중...`;

  // 초기 메시지 전송 (진행 중 상태 + 멈춰 버튼)
  const initialMessage = await client.chat.postMessage({
    channel,
    ...(isInThread && { thread_ts: event.thread_ts }),
    text: initialFallbackText,
    blocks: initialBlocks,
  });

  const responseTsRaw = initialMessage.ts;
  if (!responseTsRaw) {
    console.error("응답 메시지 타임스탬프를 가져올 수 없습니다.");
    return;
  }
  const responseTs: string = responseTsRaw;

  // 채널 루트 요청인 경우: 세션 키를 responseTs로 확정하고 세션 이동
  if (!isInThread) {
    const tempThreadTs = threadTs;
    threadTs = responseTs; // 세션 키를 responseTs로 확정
    
    // 임시 세션이 있으면 새 세션 키로 이동
    if (sessionManager.hasSession(tempThreadTs)) {
      const tempSession = sessionManager.getOrCreateSession(tempThreadTs);
      sessionManager.updateClaudeSessionId(threadTs, tempSession.claudeSessionId || '');
      sessionManager.deleteSession(tempThreadTs);
    }
    
    console.log(`[${new Date().toISOString()}] 🤖 봇 응답 생성: ${responseTs}, 세션 키 확정: ${threadTs}`);
  } else {
    console.log(`[${new Date().toISOString()}] 🤖 봇 응답 생성: ${responseTs}, 세션 키: ${threadTs}`);
  }

  const messageKey = `${channel}:${threadTs}`;
  activeMessages.set(messageKey, responseTs);

  // 세션 상태 초기화 및 타이머 시작
  const startTime = Date.now();
  const sessionState: SessionState = {
    startTime,
    timerId: null,
    channel,
    responseTs,
    userId,
    lastBlocks: initialBlocks, // 초기 블록 저장 (idempotent 업데이트용)
    lastFallbackText: initialFallbackText,
  };
  sessionStates.set(threadTs, sessionState);

  // 매초 메타데이터 업데이트 타이머 시작
  sessionState.timerId = setInterval(() => {
    updateMetadataOnly(threadTs);
  }, 1000);

  // Claude 처리
  try {
    await handleClaudeQuery(threadTs, userQuery, {
      // 진행 상황 업데이트
      onProgress: async (text: string, toolInfo: string | undefined, elapsedSeconds: number, toolCallCount: number) => {
        // 세션이 삭제되었으면 (중단된 경우) 업데이트 스킵
        if (!sessionStates.has(threadTs)) {
          return;
        }

        // 메타데이터 구성
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        const timeStr = minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;

        const version = getAppVersion();
        const commitHash = getAppStartCommitHash();
        const versionInfoParts: string[] = [];

        if (version) {
          versionInfoParts.push(`v${version}`);
        }
        if (commitHash) {
          versionInfoParts.push(`(${commitHash.substring(0, 7)})`);
        }

        const versionInfo = versionInfoParts.length > 0 ? `, ${versionInfoParts.join(" ")}` : "";
        const metadataText = `_${timeStr} 경과, 도구 ${toolCallCount}회 호출${versionInfo}_`;

        // 메시지 텍스트 구성 (슬랙 길이 제한 고려)
        const toolInfoText = toolInfo ? `${toolInfo}\n\n` : "";
        const userTag = `<@${userId}> ⏳ 작업 중...`;
        const overhead = userTag.length + toolInfoText.length + 10;
        const maxTextLength = 2500 - overhead;
        const truncatedText = truncateForSlack(text, maxTextLength);
        const messageText = `${userTag}\n\n${toolInfoText}> ${truncatedText}`;

        const progressBlocks = [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: metadataText,
              },
            ],
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: messageText,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "🛑 멈춰!",
                  emoji: true,
                },
                action_id: "stop_claude",
                value: threadTs,
              },
            ],
          },
        ];

        const fallbackText = `<@${userId}> 작업 중...`;

        // 블록과 fallback 텍스트 저장 (idempotent 업데이트용)
        sessionState.lastBlocks = progressBlocks;
        sessionState.lastFallbackText = fallbackText;

        // 즉시 업데이트 (이벤트 반영)
        await client.chat.update({
          channel,
          ts: responseTs,
          text: fallbackText,
          blocks: progressBlocks,
        });
      },

      // 최종 결과
      onResult: async (text: string, summary: { durationSeconds: number; toolCallCount: number }) => {
        // 타이머 정리 (idempotent 설계로 세션은 삭제하지 않음)
        if (sessionState.timerId) {
          clearInterval(sessionState.timerId);
          sessionState.timerId = null;
        }

        const minutes = Math.floor(summary.durationSeconds / 60);
        const seconds = summary.durationSeconds % 60;
        const timeStr = minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;

        // 버전과 커밋 해시 정보 구성
        const version = getAppVersion();
        const commitHash = getAppStartCommitHash();
        const versionInfoParts: string[] = [];

        if (version) {
          versionInfoParts.push(`v${version}`);
        }
        if (commitHash) {
          versionInfoParts.push(`(${commitHash.substring(0, 7)})`);
        }

        const versionInfo = versionInfoParts.length > 0 ? `, ${versionInfoParts.join(" ")}` : "";
        const summaryText = `_${timeStr} 소요, 도구 ${summary.toolCallCount}회 호출${versionInfo}_`;

        // 최종 메시지 텍스트 구성 (슬랙 길이 제한 고려)
        const userTag = `<@${userId}>`;
        const overhead = userTag.length + 10;
        const maxTextLength = 2500 - overhead;
        const truncatedText = truncateForSlack(text, maxTextLength);
        const finalMessageText = `${userTag}\n\n${truncatedText}`;

        const finalBlocks = [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: summaryText,
              },
            ],
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: finalMessageText,
            },
          },
        ];

        const fallbackText = `<@${userId}> ${text.slice(0, 100)}...`;

        // 블록과 fallback 텍스트 저장 (idempotent 업데이트용)
        // 이제 updateMetadataOnly가 호출되어도 이 최종 블록을 사용함
        sessionState.lastBlocks = finalBlocks;
        sessionState.lastFallbackText = fallbackText;

        await client.chat.update({
          channel,
          ts: responseTs,
          text: fallbackText,
          blocks: finalBlocks,
        });

        // Quick fix: 1초 후에 한 번 더 업데이트하여 경합 조건으로 인한 덮어쓰기 방지
        setTimeout(async () => {
          try {
            await client.chat.update({
              channel,
              ts: responseTs,
              text: fallbackText,
              blocks: finalBlocks,
            });
          } catch {
            // 재시도 실패는 무시
          }
        }, 1000);

        activeMessages.delete(messageKey);

        // 성공적인 턴어라운드 로그 (restarter.sh가 감지하는 용도)
        console.log(`[${new Date().toISOString()}] ✅ TURNAROUND_SUCCESS: 스레드 ${threadTs} 완료 (${timeStr}, 도구 ${summary.toolCallCount}회)`);
      },

      // 에러 처리
      onError: async (error: Error) => {
        // 타이머 정리 (idempotent 설계로 세션은 삭제하지 않음)
        if (sessionState.timerId) {
          clearInterval(sessionState.timerId);
          sessionState.timerId = null;
        }

        const errorBlocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `<@${userId}> ❌ 오류가 발생했습니다:\n\`\`\`${error.message}\`\`\``,
            },
          },
        ];

        const fallbackText = `<@${userId}> 오류가 발생했습니다.`;

        // 블록과 fallback 텍스트 저장 (idempotent 업데이트용)
        sessionState.lastBlocks = errorBlocks;
        sessionState.lastFallbackText = fallbackText;

        await client.chat.update({
          channel,
          ts: responseTs,
          text: fallbackText,
          blocks: errorBlocks,
        });
        activeMessages.delete(messageKey);
      },
    }, channel, responseTs, isInThread);
  } catch (error) {
    console.error("Claude 처리 중 오류:", error);
    activeMessages.delete(messageKey);

    // 타이머 정리 (idempotent 설계로 세션은 삭제하지 않음)
    if (sessionState.timerId) {
      clearInterval(sessionState.timerId);
      sessionState.timerId = null;
    }
  }
});

/**
 * "멈춰!" 버튼 액션 핸들러
 */
app.action<BlockAction<ButtonAction>>("stop_claude", async ({ body, ack, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const threadTs = action.value;
  const userId = body.user.id;
  const channel = body.channel?.id;

  if (!channel || !threadTs) {
    console.error("채널 또는 스레드 정보 없음");
    return;
  }

  console.log(`🛑 중단 요청: 스레드 ${threadTs}`);

  // 타이머 정리 (sessionStates.delete를 먼저)
  const sessionState = sessionStates.get(threadTs);
  sessionStates.delete(threadTs);
  
  if (sessionState?.timerId) {
    clearInterval(sessionState.timerId);
  }

  // 세션 중단
  const aborted = abortSession(threadTs);

  if (aborted) {
    // 메시지 업데이트
    const messageKey = `${channel}:${threadTs}`;
    const messageTs = activeMessages.get(messageKey);

    if (messageTs) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: "작업이 중단되었습니다.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `<@${userId}> ⏹️ 작업이 중단되었습니다.`,
            },
          },
        ],
      });
      activeMessages.delete(messageKey);
    }
  }
});

// 오래된 세션 정리 (30분마다)
setInterval(() => {
  sessionManager.cleanupOldSessions(60 * 60 * 1000); // 1시간 이상된 세션 정리
}, 30 * 60 * 1000);

// 앱 시작
(async () => {
  const projectDir = process.env.PROJECT_DIR || process.cwd();
  
  // 앱 시작 시점의 커밋 해시 저장
  try {
    const commitHash = execSync("git rev-parse HEAD", { 
      cwd: projectDir,
      encoding: "utf-8" 
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
