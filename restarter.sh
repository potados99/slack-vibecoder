#!/bin/bash

# restarter.sh
# 사용법: ./restarter.sh <SLACK_BOT_TOKEN> <CHANNEL_ID> <THREAD_TS> <SAFE_COMMIT_HASH>
#
# 이 스크립트는 PM2로 관리되는 slack-vibecoder 서비스를 안전하게 재시작합니다.
# 자식 프로세스에서 실행되더라도 부모 프로세스가 죽어도 살아남을 수 있도록
# 필요시 스스로를 detach하여 재실행합니다.

SLACK_BOT_TOKEN="$1"
CHANNEL_ID="$2"
THREAD_TS="$3"
SAFE_COMMIT_HASH="$4"
PROJECT_DIR="/home/potados/Projects/slack-vibecoder"
PM2_SERVICE_NAME="slack-vibecoder"
HEALTH_CHECK_TIMEOUT=30

# 필수 인자 검증
if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$CHANNEL_ID" ] || [ -z "$THREAD_TS" ] || [ -z "$SAFE_COMMIT_HASH" ]; then
    echo "사용법: $0 <SLACK_BOT_TOKEN> <CHANNEL_ID> <THREAD_TS> <SAFE_COMMIT_HASH>"
    exit 1
fi

# detach 모드로 재실행 (부모 프로세스가 죽어도 살아남기 위함)
if [ -z "$RESTARTER_DETACHED" ]; then
    export RESTARTER_DETACHED=1
    # nohup으로 백그라운드에서 실행하고 즉시 종료
    nohup bash "$0" "$@" > /tmp/restarter.log 2>&1 &
    disown
    echo "재시작 스크립트가 백그라운드에서 실행됩니다. 로그: /tmp/restarter.log"
    exit 0
fi

# Slack 메시지 전송 함수
send_slack_message() {
    local message="$1"
    curl -s -X POST "https://slack.com/api/chat.postMessage" \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"channel\": \"$CHANNEL_ID\", \"thread_ts\": \"$THREAD_TS\", \"text\": \"$message\"}" \
        > /dev/null
}

# PM2 로그에서 최근 에러 확인 함수
check_pm2_health() {
    # PM2 상태 확인
    local status=$(pm2 jlist 2>/dev/null | grep -o "\"name\":\"$PM2_SERVICE_NAME\"[^}]*\"status\":\"[^\"]*\"" | grep -o "\"status\":\"[^\"]*\"" | cut -d'"' -f4)

    if [ "$status" != "online" ]; then
        return 1
    fi

    # 최근 로그에서 치명적 에러 확인 (최근 10줄)
    local recent_errors=$(pm2 logs $PM2_SERVICE_NAME --nostream --lines 10 2>/dev/null | grep -iE "(error|exception|fatal|crash)" | wc -l)

    if [ "$recent_errors" -gt 3 ]; then
        return 1
    fi

    return 0
}

# PM2 재시작 이후 성공적인 턴어라운드 로그가 있는지 확인
# $1: 재시작 시점 (ISO 8601 형식)
check_turnaround_success() {
    local restart_time="$1"
    local restart_epoch=$(date -d "$restart_time" +%s 2>/dev/null)

    if [ -z "$restart_epoch" ]; then
        echo "[$(date)] 재시작 시점 파싱 실패: $restart_time"
        return 1
    fi

    # PM2 로그에서 TURNAROUND_SUCCESS 패턴을 찾음
    local log_lines=$(pm2 logs $PM2_SERVICE_NAME --nostream --lines 100 2>/dev/null | grep "TURNAROUND_SUCCESS")

    if [ -z "$log_lines" ]; then
        return 1
    fi

    # 각 라인에서 타임스탬프를 추출하고 재시작 시점 이후인지 확인
    while IFS= read -r line; do
        # [2025-01-15T12:34:56.789Z] 형식에서 타임스탬프 추출
        local timestamp=$(echo "$line" | grep -oE '\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})[^]]*\]' | head -1 | tr -d '[]')

        if [ -n "$timestamp" ]; then
            local log_epoch=$(date -d "$timestamp" +%s 2>/dev/null)

            if [ -n "$log_epoch" ] && [ "$log_epoch" -ge "$restart_epoch" ]; then
                echo "[$(date)] 재시작 이후 성공 로그 발견: $line"
                return 0
            fi
        fi
    done <<< "$log_lines"

    return 1
}

# 롤백 함수
rollback() {
    local reason="$1"
    send_slack_message "롤백을 시작합니다. 사유: $reason"

    cd "$PROJECT_DIR"
    git reset --hard "$SAFE_COMMIT_HASH"
    git checkout "$SAFE_COMMIT_HASH"

    # 의존성 재설치 (package.json이 변경되었을 수 있음)
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install

    pm2 restart "$PM2_SERVICE_NAME"

    sleep 5

    if check_pm2_health; then
        send_slack_message "롤백 완료! 커밋 $SAFE_COMMIT_HASH 으로 복원되었습니다."
    else
        send_slack_message "롤백 후에도 문제가 있습니다. 수동 확인이 필요합니다."
    fi
}

# 메인 실행 로직
main() {
    echo "[$(date)] 재시작 스크립트 시작"

    # 1. 업데이트 시작 알림
    send_slack_message "업데이트를 시작합니다. 잠시 후 서비스가 재시작됩니다..."

    # 잠시 대기 (메시지가 전송될 시간)
    sleep 2

    # 2. PM2 재시작 (재시작 시점 기록)
    RESTART_TIME=$(date -Iseconds)
    echo "[$(date)] PM2 서비스 재시작 중... (기준 시점: $RESTART_TIME)"
    pm2 restart "$PM2_SERVICE_NAME"

    # 3. 서비스가 올라올 때까지 대기
    sleep 5

    # 4. 업데이트 완료 알림
    send_slack_message "업데이트 완료! ${HEALTH_CHECK_TIMEOUT}초 내에 테스트 요청을 보내주세요. 정상 작동하지 않으면 자동으로 롤백됩니다."

    # 5. 헬스체크 대기
    echo "[$(date)] ${HEALTH_CHECK_TIMEOUT}초간 헬스체크 대기..."
    sleep "$HEALTH_CHECK_TIMEOUT"

    # 6. 상태 확인 (PM2 상태 + 성공적인 턴어라운드 로그)
    echo "[$(date)] 헬스체크 수행 중..."

    if ! check_pm2_health; then
        echo "[$(date)] PM2 상태 이상, 롤백 시작..."
        rollback "헬스체크 실패 - PM2 상태 이상 또는 에러 로그 과다 감지"
        echo "[$(date)] 재시작 스크립트 종료"
        return
    fi

    echo "[$(date)] PM2 상태 정상. 턴어라운드 성공 로그 확인 중..."

    if check_turnaround_success "$RESTART_TIME"; then
        echo "[$(date)] 헬스체크 통과! (턴어라운드 성공 로그 감지됨)"
        send_slack_message "헬스체크 통과! 업데이트가 성공적으로 완료되었습니다. (재시작 이후 정상 응답 확인됨)"
    else
        echo "[$(date)] 턴어라운드 성공 로그 없음. PM2 상태는 정상이지만 실제 동작 미확인."
        send_slack_message "헬스체크 조건부 통과. PM2 상태는 정상이지만, 재시작 이후 실제 요청 처리는 아직 확인되지 않았습니다. 테스트 요청을 보내주세요."
    fi

    echo "[$(date)] 재시작 스크립트 종료"
}

main
