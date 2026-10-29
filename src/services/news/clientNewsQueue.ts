/**
 * @license
 * SPDX-License-Identifier: MIT
 */

export interface ClientNewsStatus {
  date: string;
  stage: 'idle' | 'fetching' | 'writing' | 'ready' | 'empty' | 'error';
  totalPackets: number;
  writtenCount: number;
  readyCount: number;
  usedCount: number;
  error?: string;
  uiText: string;
}

export interface ClientNewsItem {
  id: string;
  text: string;
  used: boolean;
}

export interface PrefetchNewsOptions {
  provider?: 'gemini' | 'lmstudio';
  endpoint?: string;
  model?: string;
}

export class ClientNewsQueue {
  private activeDate: string | null = null;
  private queue: ClientNewsItem[] = [];
  private sessionUsedIds: Set<string> = new Set();
  private pollInterval: any = null;
  private currentStatus: ClientNewsStatus = {
    date: '',
    stage: 'idle',
    totalPackets: 0,
    writtenCount: 0,
    readyCount: 0,
    usedCount: 0,
    uiText: 'news: none available',
  };
  private listeners: ((status: ClientNewsStatus) => void)[] = [];

  constructor() {}

  public subscribe(fn: (status: ClientNewsStatus) => void): () => void {
    this.listeners.push(fn);
    fn(this.currentStatus);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private notify() {
    this.currentStatus = this.computeStatus();
    for (const fn of this.listeners) {
      try {
        fn(this.currentStatus);
      } catch (err) {
        console.warn('[ClientNewsQueue] Listener error:', err);
      }
    }
  }

  private computeStatus(): ClientNewsStatus {
    const readyCount = this.queue.filter((q) => !q.used).length;
    const usedCount = this.sessionUsedIds.size;
    const stage = this.currentStatus.stage;

    let uiText = 'news: none available';
    if (stage === 'fetching') {
      uiText = 'news: fetching month...';
    } else if (stage === 'writing') {
      uiText = `news: writing ${this.currentStatus.writtenCount}/${this.currentStatus.totalPackets || 8}`;
    } else if (readyCount > 0) {
      uiText = `news: ${readyCount} ready | ${usedCount} used`;
    } else if (usedCount > 0) {
      uiText = `news: 0 ready | ${usedCount} used`;
    } else if (stage === 'error' || stage === 'empty') {
      uiText = 'news: none available';
    }

    return {
      ...this.currentStatus,
      readyCount,
      usedCount,
      uiText,
    };
  }

  public getStatus(): ClientNewsStatus {
    return this.currentStatus;
  }

  /**
   * Triggers non-blocking background prefetch on server.
   * Cancels any ongoing polling/job for a previous date.
   */
  public prefetchNews(date: string, options?: PrefetchNewsOptions): void {
    if (!date) return;
    if (this.activeDate === date && (this.queue.length > 0 || this.currentStatus.stage === 'writing' || this.currentStatus.stage === 'fetching')) {
      return;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.activeDate = date;
    this.queue = [];
    this.currentStatus = {
      date,
      stage: 'fetching',
      totalPackets: 0,
      writtenCount: 0,
      readyCount: 0,
      usedCount: this.sessionUsedIds.size,
      uiText: 'news: fetching month...',
    };
    this.notify();

    // Call server API
    fetch('/api/news/prefetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date,
        provider: options?.provider,
        endpoint: options?.endpoint,
        model: options?.model,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) {
          console.warn('[ClientNewsQueue] Prefetch request returned error:', data.error);
        }
        this.pollServerStatus();
      })
      .catch((err) => {
        console.warn('[ClientNewsQueue] Prefetch network error:', err);
        this.currentStatus.stage = 'error';
        this.currentStatus.error = err?.message;
        this.notify();
      });

    // Start status polling (every 1.5s while active)
    this.pollInterval = setInterval(() => {
      this.pollServerStatus();
    }, 1500);
  }

  private async pollServerStatus() {
    if (!this.activeDate) return;
    try {
      const res = await fetch(`/api/news/prefetch/status?date=${encodeURIComponent(this.activeDate)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;

      if (data.date !== this.activeDate) return;

      const serverItems: { id: string; text: string }[] = data.readyLines || [];
      for (const sItem of serverItems) {
        if (!this.queue.some((q) => q.text === sItem.text)) {
          const isAlreadyUsed = this.sessionUsedIds.has(sItem.text);
          this.queue.push({
            id: sItem.id,
            text: sItem.text,
            used: isAlreadyUsed,
          });
        }
      }

      this.currentStatus.stage = data.stage;
      this.currentStatus.totalPackets = data.totalPackets || 0;
      this.currentStatus.writtenCount = data.writtenCount || 0;
      this.currentStatus.error = data.error;

      if (data.stage === 'ready' || data.stage === 'empty' || data.stage === 'error') {
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = null;
        }
      }
      this.notify();
    } catch (e) {
      console.warn('[ClientNewsQueue] Poll error:', e);
    }
  }

  /**
   * Retired as spoken line source: returns null so all spoken news lines
   * must come through the rich segment planner and writer.
   */
  public getNextNewsLine(): ClientNewsItem | null {
    return null;
  }

  /**
   * Marks line used (when DJ break actually plays).
   */
  public markLineUsed(text: string): void {
    if (!text) return;
    this.sessionUsedIds.add(text);
    const item = this.queue.find((q) => q.text === text);
    if (item) {
      item.used = true;
    }
    this.notify();
  }

  /**
   * Unplayed line returned to queue (REWIND / FF / SKIP).
   */
  public returnLineToQueue(text: string): void {
    if (!text) return;
    this.sessionUsedIds.delete(text);
    const item = this.queue.find((q) => q.text === text);
    if (item) {
      item.used = false;
    }
    this.notify();
  }

  /**
   * Cancels active job.
   */
  public cancel(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.activeDate) {
      fetch('/api/news/prefetch/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: this.activeDate }),
      }).catch(() => {});
    }
    this.activeDate = null;
    this.queue = [];
    this.currentStatus.stage = 'idle';
    this.notify();
  }
}

export const clientNewsQueue = new ClientNewsQueue();
