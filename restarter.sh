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

# Slack 메시지 전송 함수 (리스타터 시스템 메시지)
send_slack_message() {
    local message="$1"
    # 리스타터 메시지는 [시스템] 접두사로 구분
    local formatted_message="[시스템] $message"
    
    # Python을 사용하여 안전하게 JSON 이스케이프 처리
    local json_message=$(python3 -c "import json, sys; print(json.dumps(sys.stdin.read(), ensure_ascii=False))" <<< "$formatted_message")
    
    curl -s -X POST "https://slack.com/api/chat.postMessage" \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"channel\": \"$CHANNEL_ID\", \"thread_ts\": \"$THREAD_TS\", \"text\": $json_message}" \
        > /dev/null
}

# PM2 헬스체크 상세 정보를 저장할 전역 변수
HEALTH_CHECK_DETAILS=""

# PM2 로그에서 최근 에러 확인 함수
# 실패 시 HEALTH_CHECK_DETAILS에 상세 정보 저장
check_pm2_health() {
    HEALTH_CHECK_DETAILS=""
    
    # PM2 상태 확인
    local status=$(pm2 jlist 2>/dev/null | grep -o "\"name\":\"$PM2_SERVICE_NAME\"[^}]*\"status\":\"[^\"]*\"" | grep -o "\"status\":\"[^\"]*\"" | cut -d'"' -f4)
    
    if [ -z "$status" ]; then
        HEALTH_CHECK_DETAILS="PM2 상태를 확인할 수 없습니다. (pm2 jlist 실패 또는 서비스 미등록)"
        return 1
    fi
    
    if [ "$status" != "online" ]; then
        # PM2 상세 정보 수집
        local pm2_info=$(pm2 jlist 2>/dev/null | grep -A 20 "\"name\":\"$PM2_SERVICE_NAME\"" | head -30)
        local restart_count=$(echo "$pm2_info" | grep -o "\"restart_time\":[0-9]*" | cut -d':' -f2)
        local uptime=$(echo "$pm2_info" | grep -o "\"pm_uptime\":[0-9]*" | cut -d':' -f2)
        local memory=$(echo "$pm2_info" | grep -o "\"memory\":[0-9]*" | cut -d':' -f2)
        local cpu=$(echo "$pm2_info" | grep -o "\"cpu\":[0-9.]*" | cut -d':' -f2)
        
        HEALTH_CHECK_DETAILS="PM2 상태: $status"
        if [ -n "$restart_count" ]; then
            HEALTH_CHECK_DETAILS="$HEALTH_CHECK_DETAILS\n재시작 횟수: $restart_count"
        fi
        if [ -n "$uptime" ]; then
            local uptime_sec=$((uptime / 1000))
            HEALTH_CHECK_DETAILS="$HEALTH_CHECK_DETAILS\n업타임: ${uptime_sec}초"
        fi
        if [ -n "$memory" ]; then
            local memory_mb=$((memory / 1024 / 1024))
            HEALTH_CHECK_DETAILS="$HEALTH_CHECK_DETAILS\n메모리 사용량: ${memory_mb}MB"
        fi
        if [ -n "$cpu" ]; then
            HEALTH_CHECK_DETAILS="$HEALTH_CHECK_DETAILS\nCPU 사용률: ${cpu}%"
        fi
        
        return 1
    fi

    # PM2 상태가 online이면 정상
    return 0
}

# PM2 재시작 이후 성공적인 턴어라운드 로그가 있는지 확인
# $1: 재시작 시점 (ISO 8601 형식)
check_turnaround_success() {
    local restart_time="$1"
    # 재시작 시점을 UTC epoch로 변환 (타임존 정보가 있으면 그대로 사용, 없으면 UTC로 가정)
    local restart_epoch=$(date -u -d "$restart_time" +%s 2>/dev/null || date -u -d "${restart_time}Z" +%s 2>/dev/null)

    if [ -z "$restart_epoch" ]; then
        echo "[$(date)] 재시작 시점 파싱 실패: $restart_time"
        return 1
    fi

    echo "[$(date)] 재시작 시점 (UTC epoch): $restart_epoch"

    # PM2 로그 파일 직접 읽기 (버퍼링 문제 회피)
    # PM2 로그 파일 경로: ~/.pm2/logs/{service-name}-out.log
    local pm2_log_file="$HOME/.pm2/logs/${PM2_SERVICE_NAME}-out.log"
    
    # 로그 파일이 없으면 pm2 logs 명령 사용 (fallback)
    if [ ! -f "$pm2_log_file" ]; then
        echo "[$(date)] PM2 로그 파일을 찾을 수 없음: $pm2_log_file, pm2 logs 명령 사용"
        local log_lines=$(pm2 logs $PM2_SERVICE_NAME --nostream --lines 200 2>/dev/null | grep "TURNAROUND_SUCCESS")
    else
        # 로그 파일에서 최근 200줄 읽기
        local log_lines=$(tail -n 200 "$pm2_log_file" 2>/dev/null | grep "TURNAROUND_SUCCESS")
    fi

    if [ -z "$log_lines" ]; then
        echo "[$(date)] TURNAROUND_SUCCESS 로그를 찾을 수 없음"
        return 1
    fi

    echo "[$(date)] TURNAROUND_SUCCESS 로그 발견, 타임스탬프 확인 중..."

    # 각 라인에서 타임스탬프를 추출하고 재시작 시점 이후인지 확인
    while IFS= read -r line; do
        # [2025-01-15T12:34:56.789Z] 형식에서 타임스탬프 추출 (Z 포함)
        local timestamp=$(echo "$line" | grep -oE '\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)\]' | head -1 | tr -d '[]')
        
        # Z가 없는 경우도 처리 (밀리초 없이)
        if [ -z "$timestamp" ]; then
            timestamp=$(echo "$line" | grep -oE '\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})Z?\]' | head -1 | tr -d '[]')
            # Z가 없으면 추가
            if [ -n "$timestamp" ] && [[ ! "$timestamp" =~ Z$ ]]; then
                timestamp="${timestamp}Z"
            fi
        fi

        if [ -n "$timestamp" ]; then
            # UTC로 명시적으로 파싱
            local log_epoch=$(date -u -d "$timestamp" +%s 2>/dev/null)

            if [ -n "$log_epoch" ]; then
                echo "[$(date)] 로그 타임스탬프: $timestamp (UTC epoch: $log_epoch)"
                if [ "$log_epoch" -ge "$restart_epoch" ]; then
                    echo "[$(date)] 재시작 이후 성공 로그 발견: $line"
                    return 0
                fi
            fi
        fi
    done <<< "$log_lines"

    echo "[$(date)] 재시작 이후 TURNAROUND_SUCCESS 로그를 찾지 못함"
    return 1
}

# 롤백 함수
rollback() {
    local reason="$1"
    local details="$2"
    
    # 상세 정보가 있으면 포함하여 메시지 구성
    local message="롤백을 시작합니다.\n\n사유: $reason"
    if [ -n "$details" ]; then
        message="$message\n\n상세 정보:\n$details"
    fi
    
    send_slack_message "$message"

    cd "$PROJECT_DIR"
    git reset --hard "$SAFE_COMMIT_HASH"
    git checkout "$SAFE_COMMIT_HASH"

    # 의존성 재설치 (package.json이 변경되었을 수 있음)
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install

    pm2 restart "$PM2_SERVICE_NAME"

    sleep 5

    # 롤백 후 헬스체크
    HEALTH_CHECK_DETAILS=""
    if check_pm2_health; then
        send_slack_message "롤백 완료! 커밋 $SAFE_COMMIT_HASH 으로 복원되었습니다."
    else
        local rollback_message="롤백 후에도 문제가 있습니다. 수동 확인이 필요합니다."
        if [ -n "$HEALTH_CHECK_DETAILS" ]; then
            rollback_message="$rollback_message\n\n상세 정보:\n$HEALTH_CHECK_DETAILS"
        fi
        send_slack_message "$rollback_message"
    fi
}

# 메인 실행 로직
main() {
    echo "[$(date)] 재시작 스크립트 시작"

    # 1. 업데이트 시작 알림
    send_slack_message "업데이트를 시작합니다. 잠시 후 서비스가 재시작됩니다..."

    # 잠시 대기 (메시지가 전송될 시간)
    sleep 2

    # 2. PM2 재시작 (재시작 시점 기록 - UTC로 저장하여 로그와 일치시킴)
    RESTART_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo "[$(date)] PM2 서비스 재시작 중... (기준 시점 UTC: $RESTART_TIME)"
    pm2 restart "$PM2_SERVICE_NAME"

    # 3. 서비스가 올라올 때까지 대기
    sleep 5

    # 4. 업데이트 완료 알림
    send_slack_message "업데이트 완료! ${HEALTH_CHECK_TIMEOUT}초 내에 테스트 요청을 보내주세요. 정상 작동하지 않으면 자동으로 롤백됩니다."

    # 5. 헬스체크 폴링 (성공 로그가 발견되면 즉시 종료)
    echo "[$(date)] 헬스체크 시작 (최대 ${HEALTH_CHECK_TIMEOUT}초, 성공 로그 발견 시 즉시 종료)..."
    
    local check_interval=1  # 1초마다 확인
    local elapsed=0
    local success_detected=0
    
    while [ $elapsed -lt $HEALTH_CHECK_TIMEOUT ]; do
        # PM2 상태 확인
        if ! check_pm2_health; then
            echo "[$(date)] PM2 상태 이상, 롤백 시작..."
            echo "[$(date)] 헬스체크 상세 정보: $HEALTH_CHECK_DETAILS"
            rollback "헬스체크 실패 - PM2 상태 이상" "$HEALTH_CHECK_DETAILS"
            echo "[$(date)] 재시작 스크립트 종료"
            return
        fi

        # 턴어라운드 성공 로그 확인
        if check_turnaround_success "$RESTART_TIME" 2>/dev/null; then
            echo "[$(date)] 헬스체크 통과! (턴어라운드 성공 로그 감지됨, ${elapsed}초 경과)"
            send_slack_message "헬스체크 통과! 업데이트가 성공적으로 완료되었습니다. (재시작 이후 정상 응답 확인됨)"
            success_detected=1
            break
        fi

        sleep $check_interval
        elapsed=$((elapsed + check_interval))
    done

    # 타임아웃까지 성공 로그를 찾지 못한 경우
    if [ $success_detected -eq 0 ]; then
        echo "[$(date)] ${HEALTH_CHECK_TIMEOUT}초 타임아웃. PM2 상태는 정상이지만 턴어라운드 성공 로그 미확인."
        send_slack_message "헬스체크 조건부 통과. PM2 상태는 정상이지만, 재시작 이후 실제 요청 처리는 아직 확인되지 않았습니다. 테스트 요청을 보내주세요."
    fi

    echo "[$(date)] 재시작 스크립트 종료"
}

main
