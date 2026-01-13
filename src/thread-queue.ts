/**
 * 스레드별 큐 관리자
 *
 * 한 스레드 내에서 메시지 처리 중 새 메시지가 들어오면
 * 큐에 넣어 순차적으로 처리하는 시스템.
 */

import type { ResponseHandler } from "./response-handler";

/**
 * 큐에 대기 중인 메시지 정보
 */
export interface QueuedMessage {
  id: string;
  userQuery: string;
  userId: string;
  channel: string;
  responseTs: string; // "큐잉됨" 메시지의 ts (나중에 업데이트용)
  queuedAt: Date;
  status: "queued" | "cancelled";
}

/**
 * 스레드 상태 정보
 */
interface ThreadState {
  isProcessing: boolean;
  currentHandler: ResponseHandler | null;
  currentMessageId: string | null;
  queue: QueuedMessage[];
}

/**
 * 스레드별 큐 관리자 클래스
 *
 * Node.js 싱글스레드 특성을 활용하여 race condition을 방지합니다.
 * 상태 변경 메서드는 동기적으로 실행됩니다.
 */
class ThreadQueueManager {
  private threads: Map<string, ThreadState> = new Map();

  /**
   * 스레드 상태를 가져오거나 새로 생성합니다.
   */
  private getOrCreateState(threadTs: string): ThreadState {
    let state = this.threads.get(threadTs);
    if (!state) {
      state = {
        isProcessing: false,
        currentHandler: null,
        currentMessageId: null,
        queue: [],
      };
      this.threads.set(threadTs, state);
    }
    return state;
  }

  /**
   * 해당 스레드가 현재 처리 중인지 확인합니다.
   */
  isProcessing(threadTs: string): boolean {
    const state = this.threads.get(threadTs);
    return state?.isProcessing ?? false;
  }

  /**
   * 처리를 시작하려고 시도합니다.
   *
   * 이미 처리 중이면 false를 반환합니다.
   * 이 메서드는 atomic하게 동작합니다 (체크와 시작이 하나의 동기 연산).
   */
  tryStartProcessing(threadTs: string, handler: ResponseHandler, messageId: string): boolean {
    const state = this.getOrCreateState(threadTs);
    if (state.isProcessing) {
      return false;
    }
    state.isProcessing = true;
    state.currentHandler = handler;
    state.currentMessageId = messageId;
    return true;
  }

  /**
   * 현재 처리 중인 핸들러를 반환합니다.
   */
  getCurrentHandler(threadTs: string): ResponseHandler | null {
    const state = this.threads.get(threadTs);
    return state?.currentHandler ?? null;
  }

  /**
   * 현재 처리 중인 메시지 ID를 반환합니다.
   */
  getCurrentMessageId(threadTs: string): string | null {
    const state = this.threads.get(threadTs);
    return state?.currentMessageId ?? null;
  }

  /**
   * 처리 완료를 마킹합니다.
   *
   * 반환값: 다음에 처리할 메시지 (없으면 null)
   */
  finishProcessing(threadTs: string): QueuedMessage | null {
    const state = this.threads.get(threadTs);
    if (!state) {
      return null;
    }

    state.isProcessing = false;
    state.currentHandler = null;
    state.currentMessageId = null;

    // 큐에서 다음 메시지를 가져옴 (취소된 것은 건너뜀)
    while (state.queue.length > 0) {
      const next = state.queue.shift()!;
      if (next.status === "queued") {
        return next;
      }
    }

    return null;
  }

  /**
   * 메시지를 큐에 추가합니다.
   *
   * 반환값: 큐 내 위치 (1-based)
   */
  enqueue(threadTs: string, message: QueuedMessage): number {
    const state = this.getOrCreateState(threadTs);
    state.queue.push(message);
    return state.queue.length;
  }

  /**
   * 특정 메시지를 큐에서 취소합니다.
   *
   * 반환값: 취소 성공 여부
   */
  cancelQueued(threadTs: string, messageId: string): boolean {
    const state = this.threads.get(threadTs);
    if (!state) {
      return false;
    }

    const message = state.queue.find((m) => m.id === messageId);
    if (message && message.status === "queued") {
      message.status = "cancelled";
      return true;
    }
    return false;
  }

  /**
   * 특정 메시지를 큐에서 빼서 즉시 처리 대상으로 반환합니다.
   *
   * 반환값: 해당 메시지 (없거나 이미 취소됐으면 null)
   */
  prioritize(threadTs: string, messageId: string): QueuedMessage | null {
    const state = this.threads.get(threadTs);
    if (!state) {
      return null;
    }

    const index = state.queue.findIndex((m) => m.id === messageId && m.status === "queued");
    if (index === -1) {
      return null;
    }

    // 큐에서 제거하고 반환
    const [message] = state.queue.splice(index, 1);
    return message;
  }

  /**
   * 큐에서 특정 메시지를 조회합니다.
   */
  getQueuedMessage(threadTs: string, messageId: string): QueuedMessage | null {
    const state = this.threads.get(threadTs);
    if (!state) {
      return null;
    }
    return state.queue.find((m) => m.id === messageId) ?? null;
  }

  /**
   * 큐 길이를 반환합니다 (취소되지 않은 것만).
   */
  getQueueLength(threadTs: string): number {
    const state = this.threads.get(threadTs);
    if (!state) {
      return 0;
    }
    return state.queue.filter((m) => m.status === "queued").length;
  }

  /**
   * 스레드 상태를 정리합니다.
   */
  cleanupThread(threadTs: string): void {
    this.threads.delete(threadTs);
  }

  /**
   * 오래된 스레드 상태를 정리합니다.
   */
  cleanupOldThreads(maxAgeMs: number = 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [threadTs, state] of this.threads) {
      // 처리 중이 아니고 큐도 비어있으면 정리 대상
      if (!state.isProcessing && state.queue.length === 0) {
        this.threads.delete(threadTs);
        continue;
      }

      // 큐에 오래된 메시지가 있으면 정리
      const oldMessages = state.queue.filter((m) => now - m.queuedAt.getTime() > maxAgeMs);
      for (const msg of oldMessages) {
        msg.status = "cancelled";
      }

      // 모든 메시지가 취소되고 처리 중이 아니면 스레드 정리
      const activeMessages = state.queue.filter((m) => m.status === "queued");
      if (!state.isProcessing && activeMessages.length === 0) {
        this.threads.delete(threadTs);
      }
    }
  }
}

/**
 * 간단한 UUID 생성 함수
 */
export function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export const threadQueueManager = new ThreadQueueManager();
