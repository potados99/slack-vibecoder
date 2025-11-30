# Vibe Coder

<img src="vibecoder.png" width="200">

*바이브 코딩 "딸깍"봇!*

## 개요

> 아래 설명은 ChatGPT가 작성해주었습니다.

Vibe Coder는 Claude Code CLI를 Slack에서 자연어로 직접 사용할 수 있게 만든 개발 보조 봇이에요. 코드 분석, 버그 수정, 리팩터링, 구조 설명은 물론 패치 생성까지 멘션 만으로 처리해줘서 IDE 없이도 빠르고 유연하게 협업할 수 있고, 팀 누구나 편하게 코드 이해와 수정을 요청할 수 있는 가벼운 대화형 엔지니어처럼 동작해요.

## 사용법

1. Vibe Coder는 멘션에만 반응합니다. 채널에 초대한 뒤 @Vibe Coder를 멘션해서 프롬프트를 전달해주세요.
2. Vibe Coder의 응답 메시지에 회신(스레드)을 달면 Claude Code 세션을 유지하면서 대화를 이어나갈 수 있어요.
3. Vibe Coder와 무관하게 시작된 스레드에서도 Vibe Coder를 호출하면 그 스레드 내에서 세션이 유지됩니다.
4. 슬랙의 다른 메시지에 접근할 수 있습니다(MCP). 따라서 필요하다면 슬랙에서 찾아보라고 요청할 수 있어요.
5. 스스로의 소스 코드를 업데이트하고 커밋&푸시한 뒤 앱을 재시작할 수 있습니다. 이 작업을 프롬프트로 지시할 수 있습니다.

## 중요한 정보

1. 내부적으로는 요청을 처리할 때마다 `claude -p` 명령으로 프롬프트를 전달한 후 stdout을 파싱하는 방식으로 작동합니다. 이때 `--dangerously-skip-permissions` 옵션을 사용하여 권한 검사를 건너뜁니다.
2. 이로 인해 회사 서버에 두기에는 `claude`가 비정상적으로 작동하여 위험해질 수 있으므로, 안전을 위해 아무 것도 없는 개인(병준) 서버(OCI 무료 인스턴스)의 ~/Projects/slack-vibecoder 경로 아래에서 실행하고 있습니다.
3. Claude에 로그인된 계정은 회사에서 제공한 개인(병준) 계정입니다. 따라서 상황에 따라 사용량 제한이 걸릴 수 있습니다.
4. GitHub 연결 또한 개인(병준) 계정입니다. 따라서 커밋이 potados99 계정으로 올라갑니다.

## 이 앱을 배포하려면

### Slack쪽에서 해주어야 할 일

> 아래 설명은 제가 작업 중에 남긴 스크린샷을 바탕으로 Claude가 작성해주었습니다.

1. [Slack API 사이트](https://api.slack.com/apps)에서 새로운 앱을 생성합니다.

2. **OAuth & Permissions** 메뉴에서 다음 **Bot Token Scopes**를 추가합니다:
   - `app_mentions:read` - 앱 멘션 메시지 읽기
   - `assistant:write` - App Agent로 동작
   - `channels:history` - 채널 히스토리 조회 (MCP 용)
   - `channels:read` - 채널 기본 정보 조회
   - `chat:write` - 메시지 전송
   - `users:write` - 봇 프레즌스 설정

3. **Socket Mode** 메뉴로 이동하여 Socket Mode를 활성화합니다:
   - "Enable Socket Mode" 토글을 ON으로 설정
   - App-Level Token을 생성합니다 (이름: `slack-vibecoder`)
   - 다음 scope를 추가합니다:
     - `connections:write`
     - `authorizations:read`
     - `app_configurations:write`

4. **Event Subscriptions** 메뉴에서:
   - "Enable Events"를 ON으로 설정
   - **Subscribe to bot events**에 다음 이벤트를 추가:
     - `app_mention` - 봇 멘션 감지

5. 앱을 워크스페이스에 설치합니다:
   - **Install App** 메뉴에서 "Install to Workspace" 클릭
   - 권한을 승인합니다

6. 필요한 토큰 정보를 확인합니다:
   - **OAuth & Permissions**에서 `Bot User OAuth Token` (`xoxb-`로 시작) 복사
   - **Socket Mode**에서 `App-Level Token` (`xapp-`로 시작) 복사
   - 워크스페이스 URL에서 Team ID (`T0...` 형식) 확인

### 앱 본체 배포

다 부서져도 잃을 것 없는 안전한(?) 서버에서 이 저장소를 clone하고, `claude`를 셋업합니다.

서버 요구사항:
- pm2 (필수: restarter가 pm2 로그를 확인하여 헬스체크를 수행하므로 반드시 pm2로 실행해야 함)
- pnpm
- node
- git
- 되도록이면 `~/Projects/slack-vibecoder` 디렉토리로 클론([시스템 프롬프트](src/prompts.ts)에 그리 명시되어 있거든요).

**Clone**
```bash
$ git clone git@github.com:cartanova-ai/slack-vibecoder.git
$ cd slack-vibecoder
```

**Slack MCP 설치**
```bash
$ claude mcp add slack -s user -- npx -y @modelcontextprotocol/server-slack
```

**전역 시스템 프롬프트 설정**
```bash
$ cp ./CLAUDE.md ~/.claude/CLAUDE.md
```

**pm2로 시작**
```bash
$ pm2 start pnpm --name "slack-vibecoder" -- start
```