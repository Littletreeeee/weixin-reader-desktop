/**
 * BookCacher - 一键缓存整本书（自动翻页 + DOM提取）
 *
 * 策略：
 * 1. Cmd+S 触发一键缓存整本书
 * 2. 自动逐章翻页，等待渲染后从DOM提取文本
 * 3. 正常阅读时也自动缓存当前章节
 * 4. 通过 Tauri invoke 保存到本地文件系统
 */

import { log } from '../core/logger';
import { chapterManager } from '../core/chapter_manager';
import { invoke } from '@tauri-apps/api/core';

export class BookCacher {
  private isCaching = false;
  private shouldStop = false;
  private cachedChapterIdxs = new Set<number>();
  private bookTitle: string = '';
  private lastAutoIdx: number = -1;

  constructor() {
    this.bindShortcut();
    this.setupAutoCache();
    log.info('[BookCacher] 初始化完成 (Cmd+S 一键缓存整本书)');
  }

  private bindShortcut(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();

        if (this.isCaching) {
          // 再按一次停止
          this.shouldStop = true;
          this.showToast('⏹ 停止缓存');
          return;
        }

        this.cacheEntireBook();
      }
    });
  }

  /**
   * 自动缓存：正常阅读时静默缓存当前章节
   */
  private setupAutoCache(): void {
    setInterval(() => {
      if (this.isCaching || !this.isReaderPage()) return;
      this.silentCacheCurrentChapter();
    }, 5000);
  }

  /**
   * 一键缓存整本书
   */
  async cacheEntireBook(): Promise<void> {
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

    // 获取书名
    this.bookTitle = this.extractBookTitle();

    this.isCaching = true;
    this.shouldStop = false;

    const total = chapters.length;
    let success = 0;
    let failed = 0;

    this.showProgress(0, total, '准备缓存...');
    log.info(`[BookCacher] 开始缓存「${this.bookTitle}」共 ${total} 章`);

    // 记住当前位置，缓存结束后恢复
    const originalUrl = window.location.href;

    for (let i = 0; i < chapters.length; i++) {
      if (this.shouldStop) break;

      const ch = chapters[i];
      const title = ch.title || `第${ch.chapterIdx + 1}章`;

      this.updateProgress(i + 1, total, `正在缓存: ${title}`);

      // 导航到该章节
      const chapterUrl = chapterManager.buildChapterUrl(ch.chapterIdx);
      if (!chapterUrl) {
        failed++;
        continue;
      }

      try {
        // 跳转到章节
        window.location.href = chapterUrl;

        // 等待页面渲染
        await this.waitForContent(4000);

        // 从DOM提取内容
        const content = this.extractChapterContent();

        if (content && content.length > 50) {
          // 保存到文件系统
          await invoke('save_book_cache', {
            bookId,
            chapterId: String(ch.chapterIdx),
            title,
            content,
          });
          success++;
          this.cachedChapterIdxs.add(ch.chapterIdx);
        } else {
          failed++;
          log.warn(`[BookCacher] 内容提取失败: ${title} (长度: ${content?.length || 0})`);
        }
      } catch (e) {
        failed++;
        log.warn(`[BookCacher] 缓存异常: ${title}`, e);
      }

      // 短暂延迟，避免过快
      await this.delay(500);
    }

    // 保存书名信息
    try {
      await invoke('save_book_cache', {
        bookId,
        chapterId: '__bookinfo__',
        title: this.bookTitle,
        content: JSON.stringify({
          bookTitle: this.bookTitle,
          totalChapters: total,
          cachedChapters: success,
          cachedAt: Date.now(),
        }),
      });
    } catch (e) {}

    this.isCaching = false;
    this.hideProgress();

    // 恢复原来的阅读位置
    if (!this.shouldStop) {
      window.location.href = originalUrl;
    }

    const msg = this.shouldStop
      ? `⏹ 已停止 (${success}/${total}章已缓存)`
      : `✅ 缓存完成！${success}/${total}章 ${failed > 0 ? `(${failed}章失败)` : ''}`;

    log.info(`[BookCacher] ${msg}`);
    // 等页面恢复后显示结果
    setTimeout(() => this.showResult(success, failed, total), 1500);
  }

  /**
   * 静默缓存当前章节（自动缓存，不打扰用户）
   */
  private async silentCacheCurrentChapter(): Promise<void> {
    try {
      if (!chapterManager.isInitialized()) {
        const bookIdMatch = window.location.pathname.match(/\/web\/reader\/([^/]+)/);
        if (!bookIdMatch) return;
        await chapterManager.initialize(bookIdMatch[1]);
        if (!chapterManager.isInitialized()) return;
      }

      const bookId = chapterManager.getBookId();
      if (!bookId) return;

      const chapterIdx = this.getCurrentChapterIdx();
      if (chapterIdx < 0 || this.cachedChapterIdxs.has(chapterIdx)) return;
      if (chapterIdx === this.lastAutoIdx) return;

      const content = this.extractChapterContent();
      if (!content || content.length < 50) return;

      const chapterInfo = chapterManager.getChapterByIdx(chapterIdx);
      const title = chapterInfo?.title || `第${chapterIdx + 1}章`;

      if (!this.bookTitle) this.bookTitle = this.extractBookTitle();

      await invoke('save_book_cache', {
        bookId,
        chapterId: String(chapterIdx),
        title,
        content,
      });

      // 保存书名
      await invoke('save_book_cache', {
        bookId,
        chapterId: '__bookinfo__',
        title: this.bookTitle || '未知书名',
        content: JSON.stringify({ bookTitle: this.bookTitle, cachedAt: Date.now() }),
      });

      this.cachedChapterIdxs.add(chapterIdx);
      this.lastAutoIdx = chapterIdx;
      log.info(`[BookCacher] 自动缓存: ${title} (${this.cachedChapterIdxs.size}章)`);
    } catch (e) {
      // 静默失败
    }
  }

  // ==================== 等待和检测 ====================

  /**
   * 等待页面内容渲染完成
   */
  private waitForContent(maxWait: number): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const content = this.extractChapterContent();
        if (content && content.length > 50) {
          resolve();
          return;
        }
        if (Date.now() - start > maxWait) {
          resolve(); // 超时也继续
          return;
        }
        setTimeout(check, 300);
      };
      setTimeout(check, 800); // 至少等800ms让页面开始渲染
    });
  }

  // ==================== DOM提取 ====================

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

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent && el.textContent.trim().length > 50) {
        return this.extractTextWithParagraphs(el as HTMLElement);
      }
    }
    return '';
  }

  private extractTextWithParagraphs(el: HTMLElement): string {
    const paragraphs: string[] = [];
    const pElements = el.querySelectorAll('p, [class*="paragraph"], .wr_readerNote_text');
    
    if (pElements.length > 0) {
      pElements.forEach(p => {
        const text = (p as HTMLElement).innerText?.trim();
        if (text) paragraphs.push(text);
      });
    }

    return paragraphs.length > 0 ? paragraphs.join('\n\n') : (el.innerText || '');
  }

  private extractBookTitle(): string {
    const pageTitle = document.title;
    if (pageTitle && !pageTitle.includes('微信读书') && pageTitle.length > 1) {
      return pageTitle.replace(/[-–—].*$/, '').trim();
    }

    const selectors = ['.readerTopBar_title_book', '.readerTopBar_title', '[class*="bookTitle"]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return '未知书名';
  }

  private getCurrentChapterIdx(): number {
    const chapters = chapterManager.getChapters();
    if (!chapters.length) return -1;

    // 从DOM匹配章节标题
    const selectors = ['.readerTopBar_title_chapter', '[class*="chapterTitle"]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        const title = el.textContent.trim();
        const matched = chapters.find(ch => ch.title === title);
        if (matched) return matched.chapterIdx;
      }
    }

    // 从URL匹配
    const path = window.location.pathname;
    for (const ch of chapters) {
      const url = chapterManager.buildChapterUrl(ch.chapterIdx);
      if (url) {
        const seg = url.replace('https://weread.qq.com', '');
        if (path === seg) return ch.chapterIdx;
      }
    }

    return 0;
  }

  private isReaderPage(): boolean {
    return window.location.pathname.includes('/web/reader/');
  }

  // ==================== UI ====================

  private showProgress(current: number, total: number, text: string): void {
    this.hideProgress();
    const el = document.createElement('div');
    el.id = 'bc-progress';
    el.innerHTML = `
      <div style="
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.9); color: white; padding: 16px 24px;
        border-radius: 12px; font-size: 13px; z-index: 99999;
        min-width: 320px; max-width: 420px; backdrop-filter: blur(12px);
        box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      ">
        <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
          <span style="font-weight:600;">📥 缓存「${this.bookTitle}」</span>
          <span id="bc-count" style="opacity:0.7;">${current}/${total}</span>
        </div>
        <div style="background:rgba(255,255,255,0.15); border-radius:4px; height:6px; overflow:hidden; margin-bottom:8px;">
          <div id="bc-bar" style="background:linear-gradient(90deg,#4CAF50,#8BC34A); height:100%;
            width:${total > 0 ? (current/total*100) : 0}%; border-radius:4px; transition:width 0.3s;"></div>
        </div>
        <div id="bc-text" style="opacity:0.6; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${text}</div>
        <div style="margin-top:8px; opacity:0.4; font-size:11px; text-align:center;">再按 Cmd+S 可停止</div>
      </div>
    `;
    document.body.appendChild(el);
  }

  private updateProgress(current: number, total: number, text: string): void {
    const c = document.getElementById('bc-count');
    const b = document.getElementById('bc-bar');
    const t = document.getElementById('bc-text');
    if (c) c.textContent = `${current}/${total}`;
    if (b) b.style.width = `${(current/total*100)}%`;
    if (t) t.textContent = text;
  }

  private hideProgress(): void {
    document.getElementById('bc-progress')?.remove();
  }

  private showResult(success: number, failed: number, total: number): void {
    const emoji = failed === 0 ? '✅' : '⚠️';
    const el = document.createElement('div');
    el.innerHTML = `
      <div style="
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.9); color: white; padding: 16px 24px;
        border-radius: 12px; font-size: 13px; z-index: 99999;
        min-width: 300px; backdrop-filter: blur(12px);
        box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      ">
        <div style="font-weight:600; font-size:14px; margin-bottom:8px;">${emoji} 缓存完成</div>
        <div style="opacity:0.8; font-size:12px;">
          📖 ${success}/${total} 章已缓存${failed > 0 ? ` · ❌ ${failed} 章失败` : ''}<br>
          📶 离线时可阅读已缓存的章节
        </div>
        <div style="margin-top:8px; opacity:0.4; font-size:11px; text-align:center;">3秒后关闭</div>
      </div>
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  private showToast(message: string): void {
    const el = document.createElement('div');
    el.innerHTML = `
      <div style="
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.85); color: white; padding: 12px 20px;
        border-radius: 8px; font-size: 13px; z-index: 99999;
        backdrop-filter: blur(8px); font-family: -apple-system, sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      ">${message}</div>
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  public destroy(): void {
    this.shouldStop = true;
    this.isCaching = false;
  }
}
