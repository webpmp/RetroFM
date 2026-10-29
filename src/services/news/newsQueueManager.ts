/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { NewsPacket } from '../djBreak/newsAudit.js';
import { getReducedMonthlyArchive, selectNewsPackets } from './nytArchiveService.js';
import { writeAndAuditNewsLine, NewsWriterOptions } from './newsLineWriter.js';
import { readAuditedNewsCache, writeAuditedNewsCache, CachedNewsLine } from './newsQueueCache.js';

export interface NewsQueueStatus {
  date: string;
  stage: 'idle' | 'fetching' | 'writing' | 'ready' | 'empty' | 'error';
  totalPackets: number;
  writtenCount: number;
  readyCount: number;
  usedCount: number;
  error?: string;
  uiText: string;
}

export interface NewsQueueItem {
  id: string;
  text: string;
  packet: NewsPacket;
  used: boolean;
}

export class NewsQueueManager {
  private activeDate: string | null = null;
  private queue: NewsQueueItem[] = [];
  private sessionUsedLineTexts: Set<string> = new Set();
  private abortController: AbortController | null = null;
  private isJobRunning = false;
  private currentStage: 'idle' | 'fetching' | 'writing' | 'ready' | 'empty' | 'error' = 'idle';
  private totalPacketsToProcess = 0;
  private writtenCount = 0;
  private errorMessage?: string;

  /** Listeners for status updates (e.g. for UI display) */
  private listeners: ((status: NewsQueueStatus) => void)[] = [];

  constructor() {}

  public subscribe(fn: (status: NewsQueueStatus) => void): () => void {
    this.listeners.push(fn);
    fn(this.getStatus());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private notify() {
    const status = this.getStatus();
    for (const l of this.listeners) {
      try {
        l(status);
      } catch (err) {
        console.warn('[NewsQueueManager] Listener error:', err);
      }
    }
  }

  public getStatus(): NewsQueueStatus {
    const readyCount = this.queue.filter((q) => !q.used).length;
    const usedCount = this.sessionUsedLineTexts.size;

    let uiText = 'news: none available';
    if (this.currentStage === 'fetching') {
      uiText = 'news: fetching month...';
    } else if (this.currentStage === 'writing') {
      uiText = `news: writing ${this.writtenCount}/${this.totalPacketsToProcess || 8}`;
    } else if (readyCount > 0) {
      uiText = `news: ${readyCount} ready | ${usedCount} used`;
    } else if (usedCount > 0) {
      uiText = `news: 0 ready | ${usedCount} used`;
    } else if (this.currentStage === 'error') {
      uiText = 'news: none available';
    } else if (this.currentStage === 'empty') {
      uiText = 'news: none available';
    }

    return {
      date: this.activeDate || '',
      stage: this.currentStage,
      totalPackets: this.totalPacketsToProcess,
      writtenCount: this.writtenCount,
      readyCount,
      usedCount,
      error: this.errorMessage,
      uiText,
    };
  }

  /**
   * Starts a non-blocking background job prefetchNews(date).
   * Cancels any job for a previous date when the date changes.
   */
  public prefetchNews(date: string, options?: NewsWriterOptions): void {
    if (!date) return;

    if (this.activeDate === date && (this.isJobRunning || this.queue.length > 0)) {
      return;
    }

    // Cancel any job for a previous date
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.activeDate = date;
    this.queue = [];
    // Note: sessionUsedLineTexts is per-session to prevent repeating lines
    this.errorMessage = undefined;
    this.writtenCount = 0;
    this.totalPacketsToProcess = 0;

    // Load instantly from server/local cache if available
    const cachedLines = readAuditedNewsCache(date);
    if (cachedLines.length > 0) {
      for (const item of cachedLines) {
        if (!this.sessionUsedLineTexts.has(item.line.trim().toLowerCase())) {
          this.queue.push({
            id: `cached_${date}_${Math.random().toString(36).substring(2, 8)}`,
            text: item.line,
            packet: item.packet,
            used: false,
          });
        }
      }
      if (this.queue.length > 0) {
        this.currentStage = 'ready';
        this.notify();
      }

      // If at least 8 cached, we are fully stocked!
      if (cachedLines.length >= 8) {
        return;
      }
    }

    // Background prefetch and top-up
    const controller = new AbortController();
    this.abortController = controller;
    this.isJobRunning = true;
    this.currentStage = cachedLines.length > 0 ? 'ready' : 'fetching';
    this.notify();

    // Run non-blocking background task
    (async () => {
      try {
        await this.runPrefetchJob(date, controller.signal, options);
      } catch (err: any) {
        if (!controller.signal.aborted) {
          console.warn(`[NewsQueueManager] Error in prefetch job for ${date}:`, err);
          this.errorMessage = err?.message || 'Prefetch failed';
          if (this.queue.length === 0) {
            this.currentStage = 'error';
          }
          this.notify();
        }
      } finally {
        if (!controller.signal.aborted) {
          this.isJobRunning = false;
          if (this.queue.filter((q) => !q.used).length > 0) {
            this.currentStage = 'ready';
          } else if (this.currentStage !== 'error') {
            this.currentStage = 'empty';
          }
          this.notify();
        }
      }
    })();
  }

  private async runPrefetchJob(
    date: string,
    signal: AbortSignal,
    options?: NewsWriterOptions
  ): Promise<void> {
    const [yearStr, monthStr] = date.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    if (isNaN(year) || isNaN(month)) {
      this.currentStage = 'error';
      this.errorMessage = `Invalid date format: ${date}`;
      this.notify();
      return;
    }

    if (this.queue.length === 0) {
      this.currentStage = 'fetching';
      this.notify();
    }

    // Step 1: Fetch and reduce monthly archive
    const { articles, error, status } = await getReducedMonthlyArchive(year, month);
    if (signal.aborted) return;

    if (status === 'ERROR' || status === 'RATE_LIMIT' || error) {
      console.warn(`[NewsQueueManager] NYT archive fetch status=${status}: ${error}`);
      if (this.queue.length === 0) {
        this.currentStage = 'error';
        this.errorMessage = error;
        this.notify();
      }
      return;
    }

    // Step 2: Select 8 to 10 packets
    const packets = selectNewsPackets(articles, date);
    if (signal.aborted) return;

    if (packets.length === 0) {
      console.log(`[NewsQueueManager] No usable news packets found for date ${date}`);
      if (this.queue.length === 0) {
        this.currentStage = 'empty';
        this.notify();
      }
      return;
    }

    this.totalPacketsToProcess = packets.length;
    this.writtenCount = 0;
    this.currentStage = 'writing';
    this.notify();

    // Already cached lines for this date
    const cachedLines = readAuditedNewsCache(date);
    const cachedHeadlines = new Set(cachedLines.map((c) => c.packet.headline.trim().toLowerCase()));

    // Step 3: Write and audit, one packet at a time, most interesting first
    for (let i = 0; i < packets.length; i++) {
      if (signal.aborted) return;
      const packet = packets[i];

      // If this headline is already in cache, skip AI writing
      if (cachedHeadlines.has(packet.headline.trim().toLowerCase())) {
        this.writtenCount++;
        this.notify();
        continue;
      }

      this.writtenCount = i + 1;
      this.currentStage = 'writing';
      this.notify();

      try {
        const auditResult = await writeAndAuditNewsLine(packet, options);
        if (signal.aborted) return;

        if (auditResult && auditResult.result === 'ok') {
          const cacheEntry: CachedNewsLine = {
            date,
            line: auditResult.line,
            packet,
            auditedAt: new Date().toISOString(),
          };

          // Save to server-side file cache
          cachedLines.push(cacheEntry);
          writeAuditedNewsCache(date, cachedLines);
          cachedHeadlines.add(packet.headline.trim().toLowerCase());

          // Offer to queue immediately if not already used in session
          if (!this.sessionUsedLineTexts.has(auditResult.line.trim().toLowerCase())) {
            this.queue.push({
              id: `live_${date}_${Math.random().toString(36).substring(2, 8)}`,
              text: auditResult.line,
              packet,
              used: false,
            });
            this.currentStage = 'ready';
            this.notify();
          }
        }
      } catch (err: any) {
        console.warn(`[NewsQueueManager] Error writing packet "${packet.headline}":`, err);
      }
    }
  }

  /**
   * Retired as spoken line source: returns null so all spoken news lines
   * must come through the rich segment planner and writer.
   */
  public getNextNewsLine(): NewsQueueItem | null {
    return null;
  }

  /**
   * Marks a specific news item as used (when the break actually plays).
   */
  public markLineUsed(idOrText: string): void {
    const item = this.queue.find((q) => q.id === idOrText || q.text === idOrText);
    if (item) {
      item.used = true;
      this.sessionUsedLineTexts.add(item.text.trim().toLowerCase());
    } else {
      this.sessionUsedLineTexts.add(idOrText.trim().toLowerCase());
    }
    this.notify();
  }

  /**
   * If an unplayed break is discarded (e.g. rewind/skip/FF), returns the news line to the queue.
   */
  public returnLineToQueue(idOrText: string): void {
    const item = this.queue.find((q) => q.id === idOrText || q.text === idOrText);
    if (item) {
      item.used = false;
      this.sessionUsedLineTexts.delete(item.text.trim().toLowerCase());
      this.notify();
    }
  }

  /**
   * Manually cancels active jobs.
   */
  public cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isJobRunning = false;
  }

  /**
   * Resets session usage history if desired.
   */
  public resetSession(): void {
    this.cancel();
    this.activeDate = null;
    this.queue = [];
    this.sessionUsedLineTexts.clear();
    this.currentStage = 'idle';
    this.notify();
  }
}

// Global singleton instance for the app
export const globalNewsQueueManager = new NewsQueueManager();
