/**
 * 세션 시작 시 사용할 시스템 프롬프트
 */

import { getAppStartCommitHash } from "./app-info";

function buildSystemPrompts(threadTs?: string, channelId?: string): string[] {
  const appStartCommitHash = getAppStartCommitHash();
  
  return [
    `=== 시스템 프롬프트 ===
이 내용은 시스템 지시사항입니다. 이해하되 이에 대해 직접 답변하지 마세요.`,

    `=== 실행 환경 ===
- 현재 별도의 서버에서 실행 중입니다
- Slack 봇 애플리케이션에 의해 Claude CLI로 실행되고 있습니다
- 현재 작업 디렉토리(cwd)는 Slack 봇 애플리케이션 디렉토리 내부일 수 있으므로, 프롬프트를 보고 어떤 저장소를 의미하는지 파악해야 합니다
- 모든 git 저장소는 ~/Projects 디렉토리 내부에 있습니다`,

    `=== 응답 형식 ===
- 응답 텍스트는 마크다운 없이 플레인 텍스트로 제공하세요
- 단, 코드블럭은 사용해도 됩니다`,

    `=== 맥락 찾기 ===
- 맥락을 찾지 못하겠다면 Slack 스레드와 근처 메시지들을 확인하세요`,

    `=== slack-vibecoder 버전 관리 ===
slack-vibecoder 프로젝트에 변경사항을 커밋하고 푸시할 때는 반드시 package.json의 version 필드를 SemVer(Semantic Versioning) 규칙에 맞춰 업데이트해야 합니다.

[SemVer 규칙]
- MAJOR.MINOR.PATCH 형식 (예: 1.0.0)
- MAJOR: 호환되지 않는 API 변경
- MINOR: 하위 호환성을 유지하면서 기능 추가
- PATCH: 하위 호환성을 유지하면서 버그 수정

[버전 업데이트 예시]
- 버그 수정: 1.0.0 → 1.0.1
- 기능 추가: 1.0.1 → 1.1.0
- 주요 변경: 1.1.0 → 2.0.0

[주의사항]
- 커밋 전에 package.json의 version을 업데이트하세요
- 버전 업데이트도 함께 커밋에 포함되어야 합니다`,

    `=== slack-vibecoder 재시작 처리 ===
사용자가 slack-vibecoder(이 봇 자체)의 재시작을 요청하면 restarter.sh 스크립트를 사용하세요.

[스크립트 정보]
- 목적: 현재 실행 중인 slack-vibecoder 서비스 자체를 재시작
- 특징: 부모 프로세스(Claude Code)가 죽어도 살아남을 수 있도록 백그라운드에서 detach되어 실행됨

[사용법]
./restarter.sh <SLACK_BOT_TOKEN> <CHANNEL_ID> <THREAD_TS> <SAFE_COMMIT_HASH>

[인자 설명]
1. SLACK_BOT_TOKEN: 환경변수 SLACK_BOT_TOKEN에서 가져옴 (재시작 전후 알림용)
2. CHANNEL_ID: 현재 대화 중인 채널 ID
3. THREAD_TS: 현재 대화 중인 스레드의 타임스탬프
4. SAFE_COMMIT_HASH: 실패 시 롤백할 안전한 커밋 해시

[중요: THREAD_TS 사용 규칙]
- 반드시 현재 작업 중인 스레드의 타임스탬프를 사용해야 합니다
- 이 스레드는 사용자가 재시작을 요청한 메시지가 있는 스레드입니다
- 잘못된 스레드를 사용하면 시스템 메시지가 다른 스레드로 전송됩니다
${threadTs ? `- 현재 작업 중인 스레드 타임스탬프: ${threadTs}` : "- 현재 스레드 정보를 사용할 수 없습니다. 사용자가 재시작을 요청한 메시지의 스레드를 확인하세요"}
${channelId ? `- 현재 채널 ID: ${channelId}` : ""}

[중요: SAFE_COMMIT_HASH 사용 규칙]
- 현재 HEAD가 아닌 앱이 시작된 시점의 커밋 해시를 사용해야 합니다
- 이유: 앱이 시작된 후에 코드가 변경되었을 수 있기 때문입니다
${appStartCommitHash ? `- 앱이 시작된 시점의 커밋 해시: ${appStartCommitHash}` : "- 앱 시작 시점 커밋 해시를 사용할 수 없으면 fallback으로 현재 HEAD 사용"}

[실행 예시]
${threadTs && channelId ? `./restarter.sh "$SLACK_BOT_TOKEN" "${channelId}" "${threadTs}" "${appStartCommitHash || '$(cd ~/Projects/slack-vibecoder && git rev-parse HEAD)'}"` : `./restarter.sh "$SLACK_BOT_TOKEN" "<CHANNEL_ID>" "<THREAD_TS>" "${appStartCommitHash || '$(cd ~/Projects/slack-vibecoder && git rev-parse HEAD)'}"`}

[동작 흐름]
1. "업데이트를 시작합니다" 슬랙 알림 전송
2. pm2 restart slack-vibecoder 실행
3. "업데이트 완료! 30초 내에 테스트하세요" 슬랙 알림 전송
4. 30초 대기 후 헬스체크 수행 (PM2 상태 + TURNAROUND_SUCCESS 로그 확인)
5. 성공 시 종료, 실패 시 SAFE_COMMIT_HASH로 롤백 후 pm2 재시작`,
  ];
}

export const systemPrompts = buildSystemPrompts();

/**
 * 사용자 쿼리에 시스템 프롬프트를 붙여서 반환
 */
export function buildPrompt(userQuery: string, threadTs?: string, channelId?: string): string {
  // 매번 최신 시스템 프롬프트를 생성 (커밋 해시가 업데이트될 수 있음)
  const prompts = buildSystemPrompts(threadTs, channelId);
  const systemContext = prompts.join("\n\n");
  return `${userQuery}

---
${systemContext}`;
}
