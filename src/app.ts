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
const requiredEnvVars = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
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
  lastText: string;
  lastToolInfo: string | undefined;
  lastToolCallCount: number;
  channel: string;
  responseTs: string; // 항상 존재함 (초기화 시 체크함)
  userId: string;
}

const sessionStates = new Map<string, SessionState>();

/**
 * 메타데이터만 업데이트하는 함수 (타이머용)
 */
async function updateMetadataOnly(threadTs: string): Promise<void> {
  const state = sessionStates.get(threadTs);
  if (!state || !state.responseTs) return;

  const responseTs = state.responseTs; // 타입 가드를 위한 변수 추출
  const elapsedSeconds = Math.round((Date.now() - state.startTime) / 1000);
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
  const metadataText = `_${timeStr} 경과, 도구 ${state.lastToolCallCount}회 호출${versionInfo}_`;

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
        text: `<@${state.userId}> ⏳ 작업 중...\n\n${state.lastToolInfo ? `${state.lastToolInfo}\n\n` : ""}> ${state.lastText.slice(0, 2900)}${state.lastText.length > 2900 ? "..." : ""}`,
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

  try {
    await app.client.chat.update({
      channel: state.channel,
      ts: responseTs,
      text: `<@${state.userId}> 작업 중...`,
      blocks: progressBlocks,
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
  const userId = event.user;
  const channel = event.channel;
  const messageTs = event.ts;
  // 스레드 안에서 멘션한 경우에만 스레드로 답장, 아니면 채널에 직접 답장
  const isInThread = !!event.thread_ts;
  const threadTs = event.thread_ts || messageTs; // 세션 키로 사용

  // 멘션에서 봇 태그 제거하고 실제 메시지 추출
  const botMentionRegex = /<@[A-Z0-9]+>/g;
  const userQuery = event.text.replace(botMentionRegex, "").trim();

  if (!userQuery) {
    await say({
      text: `<@${userId}> 무엇을 도와드릴까요? 메시지를 함께 보내주세요!`,
      ...(isInThread && { thread_ts: threadTs }),
    });
    return;
  }

  console.log(`[${new Date().toISOString()}] 📩 멘션 수신: ${userQuery} (스레드: ${threadTs})`);

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

  // 초기 메시지 전송 (진행 중 상태 + 멈춰 버튼)
  // 스레드 안이면 스레드로, 아니면 채널에 직접
  const initialMessage = await client.chat.postMessage({
    channel,
    ...(isInThread && { thread_ts: threadTs }),
    text: `<@${userId}> 🤔 생각하는 중...`,
    blocks: [
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
    ],
  });

  const responseTsRaw = initialMessage.ts;
  if (!responseTsRaw) {
    console.error("응답 메시지 타임스탬프를 가져올 수 없습니다.");
    return;
  }
  // 타입 단언: 위에서 체크했으므로 string임이 보장됨
  const responseTs: string = responseTsRaw;

  const messageKey = `${channel}:${threadTs}`;
  activeMessages.set(messageKey, responseTs);

  // 세션 상태 초기화 및 타이머 시작
  const startTime = Date.now();
  const sessionState = {
    startTime,
    timerId: null,
    lastText: "",
    lastToolInfo: undefined,
    lastToolCallCount: 0,
    channel,
    responseTs,
    userId,
  } as SessionState;
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
        // 세션 상태 업데이트
        sessionState.lastText = text;
        sessionState.lastToolInfo = toolInfo;
        sessionState.lastToolCallCount = toolCallCount;

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
              text: `<@${userId}> ⏳ 작업 중...\n\n${toolInfo ? `${toolInfo}\n\n` : ""}> ${text.slice(0, 2900)}${text.length > 2900 ? "..." : ""}`,
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

        // 즉시 업데이트 (이벤트 반영)
        await client.chat.update({
          channel,
          ts: responseTs,
          text: `<@${userId}> 작업 중...`,
          blocks: progressBlocks,
        });
      },

      // 최종 결과
      onResult: async (text: string, summary: { durationSeconds: number; toolCallCount: number }) => {
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

        await client.chat.update({
          channel,
          ts: responseTs,
          text: `<@${userId}> ${text}`,
          blocks: [
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
                text: `<@${userId}>\n\n${text.slice(0, 2900)}${text.length > 2900 ? "..." : ""}`,
              },
            },
          ],
        });
        activeMessages.delete(messageKey);

        // 타이머 정리
        const sessionState = sessionStates.get(threadTs);
        if (sessionState?.timerId) {
          clearInterval(sessionState.timerId);
          sessionState.timerId = null;
        }
        sessionStates.delete(threadTs);

        // 성공적인 턴어라운드 로그 (restarter.sh가 감지하는 용도)
        console.log(`[${new Date().toISOString()}] ✅ TURNAROUND_SUCCESS: 스레드 ${threadTs} 완료 (${timeStr}, 도구 ${summary.toolCallCount}회)`);
      },

      // 에러 처리
      onError: async (error: Error) => {
        // 타이머 정리
        const sessionState = sessionStates.get(threadTs);
        if (sessionState?.timerId) {
          clearInterval(sessionState.timerId);
          sessionState.timerId = null;
        }
        sessionStates.delete(threadTs);
        await client.chat.update({
          channel,
          ts: responseTs,
          text: `<@${userId}> 오류가 발생했습니다.`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `<@${userId}> ❌ 오류가 발생했습니다:\n\`\`\`${error.message}\`\`\``,
              },
            },
          ],
        });
        activeMessages.delete(messageKey);
      },
    }, channel, responseTs, isInThread);
  } catch (error) {
    console.error("Claude 처리 중 오류:", error);
    activeMessages.delete(messageKey);
    
    // 타이머 정리
    const sessionState = sessionStates.get(threadTs);
    if (sessionState?.timerId) {
      clearInterval(sessionState.timerId);
      sessionState.timerId = null;
    }
    sessionStates.delete(threadTs);
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

  // 타이머 정리
  const sessionState = sessionStates.get(threadTs);
  if (sessionState?.timerId) {
    clearInterval(sessionState.timerId);
    sessionState.timerId = null;
  }
  sessionStates.delete(threadTs);

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
