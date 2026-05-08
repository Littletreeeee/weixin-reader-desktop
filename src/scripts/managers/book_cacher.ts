/**
 * BookCacher - 一键缓存整本书（跨页面持久化）
 *
 * 原理：
 * 1. Cmd+S 触发，将缓存任务存入 localStorage
 * 2. 导航到目标章节（页面重载）
 * 3. inject.js 重新加载后，BookCacher 检测到未完成的任务
 * 4. 提取当前页面内容，保存，导航到下一章
 * 5. 重复直到所有章节完成
 */

import { log } from '../core/logger';
import { chapterManager } from '../core/chapter_manager';
import { invoke } from '@tauri-apps/api/core';

interface CacheTask {
  bookId: string;
  bookTitle: string;
  chapters: { idx: number; title: string; url: string }[];
  currentIndex: number;  // 当前正在缓存的章节索引
  successCount: number;
  failedCount: number;
  originalUrl: string;   // 缓存完成后恢复的URL
  startTime: number;
}

const TASK_KEY = 'book_cacher_task';

export class BookCacher {
  private lastAutoIdx: number = -1;

  constructor() {
    this.bindShortcut();
    this.setupAutoCache();

    // 关键：检查是否有未完成的缓存任务
    setTimeout(() => this.resumeTask(), 2000);

    log.info('[BookCacher] 初始化完成 (Cmd+S 一键缓存整本书)');
  }

  private bindShortcut(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();

        const task = this.getTask();
        if (task) {
          // 正在缓存中，按Cmd+S停止
          this.stopTask();
          this.showToast('⏹ 已停止缓存');
          return;
        }

        this.startCacheEntireBook();
      }
    });
  }

  // ==================== 任务持久化 ====================

  private getTask(): CacheTask | null {
    try {
      const raw = localStorage.getItem(TASK_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  private saveTask(task: CacheTask): void {
    localStorage.setItem(TASK_KEY, JSON.stringify(task));
  }

  private clearTask(): void {
    localStorage.removeItem(TASK_KEY);
  }

  private stopTask(): void {
    const task = this.getTask();
    this.clearTask();
    if (task) {
      // 恢复原来位置
      setTimeout(() => {
        window.location.href = task.originalUrl;
      }, 500);
    }
  }

  // ==================== 启动缓存 ====================

  async startCacheEntireBook(): Promise<void> {
    if (!this.isReaderPage()) {
      this.showToast('📖 请先打开一本书再缓存');
      return;
    }

    // 初始化ChapterManager
    if (!chapterManager.isInitialized()) {
      const bookIdMatch = window.location.pathname.match(/\/web\/reader\/([^/]+)/);
      if (!bookIdMatch) {
        this.showToast('❌ 无法识别当前书籍');
        return;
      }
      this.showToast('📡 获取书籍信息...');
      const success = await chapterManager.initialize(bookIdMatch[1]);
      if (!success) {
        this.showToast('❌ 获取章节信息失败，请确保已登录');
        return;
      }
    }

    const bookId = chapterManager.getBookId();
    const chapters = chapterManager.getChapters();
    if (!bookId || !chapters.length) {
      this.showToast('❌ 无法获取章节列表');
      return;
    }

    const bookTitle = this.extractBookTitle();

    // 构建章节URL列表
    const chapterList: { idx: number; title: string; url: string }[] = [];
    for (const ch of chapters) {
      const url = chapterManager.buildChapterUrl(ch.chapterIdx);
      if (url) {
        chapterList.push({ idx: ch.chapterIdx, title: ch.title || `第${ch.chapterIdx + 1}章`, url });
      }
    }

    if (!chapterList.length) {
      this.showToast('❌ 无法生成章节URL');
      return;
    }

    // 创建缓存任务
    const task: CacheTask = {
      bookId,
      bookTitle,
      chapters: chapterList,
      currentIndex: 0,
      successCount: 0,
      failedCount: 0,
      originalUrl: window.location.href,
      startTime: Date.now(),
    };

    this.saveTask(task);

    log.info(`[BookCacher] 开始缓存「${bookTitle}」共 ${chapterList.length} 章`);
    this.showToast(`📥 开始缓存「${bookTitle}」${chapterList.length}章...`);

    // 保存书名
    try {
      await invoke('save_book_cache', {
        bookId,
        chapterId: '__bookinfo__',
        title: bookTitle,
        content: JSON.stringify({ bookTitle, totalChapters: chapterList.length, cachedAt: Date.now() }),
      });
    } catch (e) {}

    // 导航到第一章
    setTimeout(() => {
      window.location.href = chapterList[0].url;
    }, 1000);
  }

  // ==================== 恢复/继续缓存 ====================

  /**
   * 页面加载后检查是否有未完成的任务
   */
  private async resumeTask(): Promise<void> {
    const task = this.getTask();
    if (!task) return;

    if (!this.isReaderPage()) {
      // 不在阅读页，可能是首页，等待
      return;
    }

    const total = task.chapters.length;
    const idx = task.currentIndex;

    if (idx >= total) {
      // 已完成
      this.finishTask(task);
      return;
    }

    const ch = task.chapters[idx];
    log.info(`[BookCacher] 继续缓存: ${ch.title} (${idx + 1}/${total})`);

    // 显示进度条
    this.showProgress(idx + 1, total, task.bookTitle, ch.title);

    // 等待页面内容渲染
    await this.waitForContent(5000);

    // 提取内容
    const content = this.extractChapterContent();

    if (content && content.length > 50) {
      try {
        await invoke('save_book_cache', {
          bookId: task.bookId,
          chapterId: String(ch.idx),
          title: ch.title,
          content,
        });
        task.successCount++;
        log.info(`[BookCacher] ✅ ${ch.title} (${content.length}字)`);
      } catch (e) {
        task.failedCount++;
        log.warn(`[BookCacher] ❌ 保存失败: ${ch.title}`, e);
      }
    } else {
      task.failedCount++;
      log.warn(`[BookCacher] ❌ 提取失败: ${ch.title} (长度: ${content?.length || 0})`);
    }

    // 更新任务：前进到下一章
    task.currentIndex = idx + 1;
    this.saveTask(task);

    if (task.currentIndex >= total) {
      // 全部完成
      this.finishTask(task);
      return;
    }

    // 导航到下一章（短延迟）
    const nextCh = task.chapters[task.currentIndex];
    setTimeout(() => {
      window.location.href = nextCh.url;
    }, 800);
  }

  /**
   * 缓存任务完成
   */
  private finishTask(task: CacheTask): void {
    this.clearTask();
    const elapsed = Math.round((Date.now() - task.startTime) / 1000);

    log.info(`[BookCacher] 缓存完成！成功: ${task.successCount}/${task.chapters.length}，用时: ${elapsed}秒`);

    // 恢复原来的阅读位置
    setTimeout(() => {
      window.location.href = task.originalUrl;
    }, 500);

    // 显示结果（延迟等页面恢复后）
    setTimeout(() => {
      this.showResult(task.successCount, task.failedCount, task.chapters.length, elapsed);
    }, 2000);
  }

  // ==================== 自动缓存 ====================

  private setupAutoCache(): void {
    setInterval(() => {
      if (this.getTask()) return; // 有缓存任务时不干扰
      if (!this.isReaderPage()) return;
      this.silentCacheCurrentChapter();
    }, 5000);
  }

  private async silentCacheCurrentChapter(): Promise<void> {
    try {
      if (!chapterManager.isInitialized()) {
        const m = window.location.pathname.match(/\/web\/reader\/([^/]+)/);
        if (!m) return;
        await chapterManager.initialize(m[1]);
        if (!chapterManager.isInitialized()) return;
      }

      const bookId = chapterManager.getBookId();
      if (!bookId) return;

      const chapterIdx = this.getCurrentChapterIdx();
      if (chapterIdx < 0 || chapterIdx === this.lastAutoIdx) return;

      const content = this.extractChapterContent();
      if (!content || content.length < 50) return;

      const info = chapterManager.getChapterByIdx(chapterIdx);
      const title = info?.title || `第${chapterIdx + 1}章`;
      const bookTitle = this.extractBookTitle();

      await invoke('save_book_cache', { bookId, chapterId: String(chapterIdx), title, content });
      await invoke('save_book_cache', {
        bookId, chapterId: '__bookinfo__', title: bookTitle,
        content: JSON.stringify({ bookTitle, cachedAt: Date.now() }),
      });

      this.lastAutoIdx = chapterIdx;
      log.info(`[BookCacher] 自动缓存: ${title}`);
    } catch (e) {}
  }

  // ==================== DOM提取 ====================

  private waitForContent(maxWait: number): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const content = this.extractChapterContent();
        if (content && content.length > 50) { resolve(); return; }
        if (Date.now() - start > maxWait) { resolve(); return; }
        setTimeout(check, 400);
      };
      setTimeout(check, 1000);
    });
  }

  private extractChapterContent(): string {
    const selectors = [
      '.readerChapterContent',
      '.reader_content',
      '.wr_readerContent',
      '.renderTargetContent',
      '.app_content',
      '[class*="chapterContent"]',
      '[class*="readerContent"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length > 50) {
        return this.extractText(el as HTMLElement);
      }
    }
    return '';
  }

  private extractText(el: HTMLElement): string {
    const ps: string[] = [];
    el.querySelectorAll('p, [class*="paragraph"]').forEach(p => {
      const t = (p as HTMLElement).innerText?.trim();
      if (t) ps.push(t);
    });
    return ps.length > 0 ? ps.join('\n\n') : (el.innerText || '');
  }

  private extractBookTitle(): string {
    const t = document.title;
    if (t && !t.includes('微信读书') && t.length > 1) return t.replace(/[-–—].*$/, '').trim();
    for (const sel of ['.readerTopBar_title_book', '.readerTopBar_title', '[class*="bookTitle"]']) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return '未知书名';
  }

  private getCurrentChapterIdx(): number {
    const chapters = chapterManager.getChapters();
    if (!chapters.length) return -1;
    for (const sel of ['.readerTopBar_title_chapter', '[class*="chapterTitle"]']) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        const matched = chapters.find(ch => ch.title === el!.textContent!.trim());
        if (matched) return matched.chapterIdx;
      }
    }
    return 0;
  }

  private isReaderPage(): boolean {
    return window.location.pathname.includes('/web/reader/');
  }

  // ==================== UI ====================

  private showProgress(current: number, total: number, bookTitle: string, chapterTitle: string): void {
    document.getElementById('bc-progress')?.remove();
    const el = document.createElement('div');
    el.id = 'bc-progress';
    el.innerHTML = `
      <div style="
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:rgba(0,0,0,0.92); color:white; padding:16px 24px;
        border-radius:12px; font-size:13px; z-index:99999;
        min-width:320px; max-width:420px; backdrop-filter:blur(12px);
        box-shadow:0 4px 24px rgba(0,0,0,0.4);
        font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      ">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <span style="font-weight:600;">📥 ${bookTitle}</span>
          <span style="opacity:0.7;">${current}/${total}</span>
        </div>
        <div style="background:rgba(255,255,255,0.15);border-radius:4px;height:6px;overflow:hidden;margin-bottom:8px;">
          <div style="background:linear-gradient(90deg,#4CAF50,#8BC34A);height:100%;
            width:${(current/total*100)}%;border-radius:4px;"></div>
        </div>
        <div style="opacity:0.6;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          正在缓存: ${chapterTitle}
        </div>
        <div style="margin-top:6px;opacity:0.35;font-size:11px;text-align:center;">Cmd+S 停止</div>
      </div>
    `;
    document.body.appendChild(el);
  }

  private showResult(success: number, failed: number, total: number, seconds: number): void {
    const el = document.createElement('div');
    el.innerHTML = `
      <div style="
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:rgba(0,0,0,0.92); color:white; padding:16px 24px;
        border-radius:12px; font-size:13px; z-index:99999;
        min-width:300px; backdrop-filter:blur(12px);
        box-shadow:0 4px 24px rgba(0,0,0,0.4);
        font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      ">
        <div style="font-weight:600;font-size:14px;margin-bottom:8px;">✅ 缓存完成</div>
        <div style="opacity:0.8;font-size:12px;line-height:1.6;">
          📖 ${success}/${total} 章已缓存${failed > 0 ? ` · ❌ ${failed}章失败` : ''}<br>
          ⏱ 用时 ${seconds}秒<br>
          📶 离线时可阅读
        </div>
      </div>
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  private showToast(msg: string): void {
    const el = document.createElement('div');
    el.innerHTML = `<div style="
      position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:rgba(0,0,0,0.85);color:white;padding:12px 20px;
      border-radius:8px;font-size:13px;z-index:99999;
      backdrop-filter:blur(8px);font-family:-apple-system,sans-serif;
    ">${msg}</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  public destroy(): void { this.clearTask(); }
}
