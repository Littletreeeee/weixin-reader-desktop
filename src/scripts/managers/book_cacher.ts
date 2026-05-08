/**
 * BookCacher - 应用内书籍缓存（离线阅读支持）
 *
 * 策略：
 * 1. 自动缓存：每次翻到新章节时，自动从DOM提取文本并保存
 * 2. 手动缓存：Cmd+S 提取当前章节并保存
 * 3. 所有数据通过 Tauri invoke 保存到本地文件系统
 */

import { log } from '../core/logger';
import { chapterManager } from '../core/chapter_manager';
import { invoke } from '@tauri-apps/api/core';

export class BookCacher {
  private isCaching = false;
  private cachedChapterIdxs = new Set<number>();
  private bookTitle: string = '';
  private lastChapterIdx: number = -1;

  constructor() {
    this.bindShortcut();
    this.setupAutoCache();
    log.info('[BookCacher] 初始化完成 (Cmd+S 缓存当前章节，自动缓存翻页内容)');
  }

  /**
   * 绑定快捷键 Cmd+S
   */
  private bindShortcut(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        this.cacheCurrentChapter();
      }
    });
  }

  /**
   * 设置自动缓存：监听页面变化，自动缓存新章节
   */
  private setupAutoCache(): void {
    // 每3秒检测一次是否有新章节可缓存
    setInterval(() => {
      if (!this.isReaderPage()) return;
      this.tryCacheCurrentChapter(true);
    }, 3000);
  }

  /**
   * 手动缓存当前章节（Cmd+S触发）
   */
  async cacheCurrentChapter(): Promise<void> {
    if (!this.isReaderPage()) {
      this.showToast('📖 请先打开一本书再缓存');
      return;
    }

    if (this.isCaching) {
      this.showToast('⏳ 正在缓存中...');
      return;
    }

    await this.tryCacheCurrentChapter(false);
  }

  /**
   * 尝试缓存当前章节
   * @param silent 是否静默（自动缓存时不显示toast）
   */
  private async tryCacheCurrentChapter(silent: boolean): Promise<void> {
    if (this.isCaching) return;

    try {
      this.isCaching = true;

      // 1. 确保ChapterManager已初始化
      if (!chapterManager.isInitialized()) {
        const bookIdMatch = window.location.pathname.match(/\/web\/reader\/([^/]+)/);
        if (!bookIdMatch) return;
        
        const success = await chapterManager.initialize(bookIdMatch[1]);
        if (!success) {
          if (!silent) this.showToast('❌ 获取章节信息失败，请确保已登录');
          return;
        }
      }

      const bookId = chapterManager.getBookId();
      if (!bookId) return;

      // 2. 获取当前章节索引
      const chapterIdx = this.getCurrentChapterIdx();
      if (chapterIdx < 0) return;

      // 如果是自动缓存，且该章节已缓存过，跳过
      if (silent && this.cachedChapterIdxs.has(chapterIdx)) return;

      // 3. 从DOM提取文本内容
      const content = this.extractChapterContent();
      if (!content || content.length < 50) {
        if (!silent) this.showToast('❌ 无法提取章节内容（页面可能还在加载）');
        return;
      }

      // 4. 获取章节标题
      const chapterInfo = chapterManager.getChapterByIdx(chapterIdx);
      const title = chapterInfo?.title || this.extractChapterTitle() || `第${chapterIdx + 1}章`;

      // 5. 获取书名
      if (!this.bookTitle) {
        this.bookTitle = this.extractBookTitle();
      }

      // 6. 保存到文件系统
      await invoke('save_book_cache', {
        bookId,
        chapterId: String(chapterIdx),
        title,
        content,
      });

      // 7. 额外保存书名到索引
      try {
        await invoke('save_book_cache', {
          bookId,
          chapterId: '__bookinfo__',
          title: this.bookTitle || '未知书名',
          content: JSON.stringify({
            bookTitle: this.bookTitle,
            totalChapters: chapterManager.getChapters().length,
            cachedAt: Date.now(),
          }),
        });
      } catch (e) {
        // 忽略
      }

      this.cachedChapterIdxs.add(chapterIdx);

      if (!silent) {
        const total = chapterManager.getChapters().length;
        this.showToast(`✅ 已缓存「${title}」(${this.cachedChapterIdxs.size}/${total}章)`);
      } else if (this.lastChapterIdx !== chapterIdx) {
        log.info(`[BookCacher] 自动缓存: ${title} (${this.cachedChapterIdxs.size}章已缓存)`);
      }

      this.lastChapterIdx = chapterIdx;

    } catch (error) {
      log.error('[BookCacher] 缓存失败:', error);
      if (!silent) this.showToast('❌ 缓存失败');
    } finally {
      this.isCaching = false;
    }
  }

  // ==================== DOM提取 ====================

  /**
   * 从DOM提取当前章节文本内容
   */
  private extractChapterContent(): string {
    // 微信读书的内容容器选择器（多种可能）
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
        // 获取纯文本，保留段落结构
        return this.extractTextWithParagraphs(el as HTMLElement);
      }
    }

    // 兜底：尝试获取body中的主要文本区域
    const bodyText = document.body.innerText;
    if (bodyText.length > 200) {
      return bodyText;
    }

    return '';
  }

  /**
   * 从元素中提取文本并保留段落结构
   */
  private extractTextWithParagraphs(el: HTMLElement): string {
    const paragraphs: string[] = [];
    
    // 获取所有段落元素
    const pElements = el.querySelectorAll('p, .wr_readerNote_text, [class*="paragraph"]');
    
    if (pElements.length > 0) {
      pElements.forEach(p => {
        const text = (p as HTMLElement).innerText?.trim();
        if (text) paragraphs.push(text);
      });
    }

    if (paragraphs.length > 0) {
      return paragraphs.join('\n\n');
    }

    // 兜底：直接用innerText
    return el.innerText || el.textContent || '';
  }

  /**
   * 提取当前章节标题
   */
  private extractChapterTitle(): string {
    const selectors = [
      '.readerTopBar_title_chapter',
      '.readerChapterContent_title',
      '[class*="chapterTitle"]',
      '.chapter_title',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent?.trim()) {
        return el.textContent.trim();
      }
    }

    return '';
  }

  /**
   * 提取书名
   */
  private extractBookTitle(): string {
    // 从页面title提取
    const pageTitle = document.title;
    if (pageTitle && !pageTitle.includes('微信读书')) {
      return pageTitle.replace(/-.*$/, '').trim();
    }

    // 从顶部栏提取
    const selectors = [
      '.readerTopBar_title_book',
      '.readerTopBar_title',
      '[class*="bookTitle"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent?.trim()) {
        return el.textContent.trim();
      }
    }

    return '未知书名';
  }

  /**
   * 获取当前章节索引
   */
  private getCurrentChapterIdx(): number {
    // 从URL中尝试获取
    // 微信读书URL格式: /web/reader/{bookId}{chapterSegment}
    // chapterSegment以k开头

    // 优先从ChapterManager获取当前进度
    const chapters = chapterManager.getChapters();
    if (chapters.length === 0) return -1;

    // 尝试从页面DOM获取章节标题来匹配
    const currentTitle = this.extractChapterTitle();
    if (currentTitle) {
      const matched = chapters.find(ch => ch.title === currentTitle);
      if (matched) return matched.chapterIdx;
    }

    // 尝试从URL的hash或路径获取
    const url = window.location.href;
    for (let i = 0; i < chapters.length; i++) {
      const chapterUrl = chapterManager.buildChapterUrl(chapters[i].chapterIdx);
      if (chapterUrl && url.includes(chapterUrl.split('/web/reader/')[1] || '')) {
        return chapters[i].chapterIdx;
      }
    }

    // 兜底：返回0（第一章）
    return 0;
  }

  /**
   * 检查是否在阅读页
   */
  private isReaderPage(): boolean {
    return window.location.pathname.includes('/web/reader/');
  }

  // ==================== UI ====================

  private showToast(message: string): void {
    const el = document.createElement('div');
    el.innerHTML = `
      <div style="
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.85);
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 13px;
        z-index: 99999;
        backdrop-filter: blur(8px);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        max-width: 400px;
        text-align: center;
      ">
        ${message}
      </div>
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  public destroy(): void {
    this.isCaching = false;
  }
}
