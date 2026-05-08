/**
 * BookCacher - 应用内一键缓存整本书
 *
 * 功能：
 * 1. 快捷键 Cmd+D 触发缓存当前书籍
 * 2. 自动获取所有章节URL
 * 3. 逐章下载并缓存到IndexedDB
 * 4. 显示实时进度条
 * 5. 缓存完成后通知
 */

import { log } from '../core/logger';
import { chapterManager, ChapterData } from '../core/chapter_manager';
import { CacheManager } from './cache_manager';

export class BookCacher {
  private cacheManager: CacheManager;
  private isCaching = false;
  private progressEl: HTMLElement | null = null;

  constructor() {
    this.cacheManager = CacheManager.getInstance();
    this.bindShortcut();
    log.info('[BookCacher] 初始化完成 (Cmd+S 缓存整本书)');
  }

  /**
   * 绑定快捷键 Cmd+S
   */
  private bindShortcut(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Cmd+S (Mac) / Ctrl+S (Windows)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();

        if (this.isCaching) {
          this.showToast('⏳ 正在缓存中，请稍候...');
          return;
        }

        this.cacheCurrentBook();
      }
    });
  }

  /**
   * 缓存当前正在阅读的书
   */
  async cacheCurrentBook(): Promise<void> {
    // 1. 检查是否在阅读页
    if (!window.location.pathname.includes('/web/reader/')) {
      this.showToast('📖 请先打开一本书再缓存');
      return;
    }

    // 2. 确保ChapterManager已初始化
    if (!chapterManager.isInitialized()) {
      const bookIdMatch = window.location.pathname.match(/\/web\/reader\/([^/]+)/);
      if (!bookIdMatch) {
        this.showToast('❌ 无法识别当前书籍');
        return;
      }

      this.showToast('📡 正在获取书籍信息...');
      const success = await chapterManager.initialize(bookIdMatch[1]);
      if (!success) {
        this.showToast('❌ 获取章节信息失败，请确保已登录');
        return;
      }
    }

    // 3. 获取所有章节
    const chapters = chapterManager.getChapters();
    const bookId = chapterManager.getBookId();

    if (!chapters.length || !bookId) {
      this.showToast('❌ 无法获取章节列表');
      return;
    }

    // 4. 构造所有章节URL
    const chapterUrls: { url: string; title: string; idx: number }[] = [];
    for (const ch of chapters) {
      const url = chapterManager.buildChapterUrl(ch.chapterIdx);
      if (url) {
        chapterUrls.push({
          url,
          title: ch.title,
          idx: ch.chapterIdx,
        });
      }
    }

    if (!chapterUrls.length) {
      this.showToast('❌ 无法生成章节URL');
      return;
    }

    // 5. 开始缓存
    this.isCaching = true;
    log.info(`[BookCacher] 开始缓存书籍 ${bookId}，共 ${chapterUrls.length} 章`);

    this.showProgress(0, chapterUrls.length, '准备缓存...');

    let success = 0;
    let failed = 0;
    let totalSize = 0;

    for (let i = 0; i < chapterUrls.length; i++) {
      const { url, title, idx } = chapterUrls[i];

      this.updateProgress(
        i + 1,
        chapterUrls.length,
        `正在缓存: ${title || `第${idx}章`}`
      );

      try {
        // 请求章节页面内容
        const response = await fetch(url, { credentials: 'include' });

        if (response.ok) {
          const cloned = response.clone();
          const text = await cloned.text();
          const size = new Blob([text]).size;
          totalSize += size;

          await this.cacheManager.cacheResponse(url, response, {
            bookId,
            chapterId: String(idx),
            title: title || `第${idx}章`,
          });

          success++;
        } else {
          failed++;
          log.warn(`[BookCacher] 章节请求失败: ${title} (${response.status})`);
        }
      } catch (error) {
        failed++;
        log.warn(`[BookCacher] 章节缓存异常: ${title}`, error);
      }

      // 避免请求过快被限流，每章间隔200ms
      await this.delay(200);
    }

    // 6. 缓存完成
    this.isCaching = false;
    this.hideProgress();

    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
    const message = `✅ 缓存完成！${success}/${chapterUrls.length}章 (${sizeMB}MB)`;

    log.info(`[BookCacher] ${message}`);
    this.showResult(success, failed, chapterUrls.length, totalSize);
  }

  // ==================== UI 组件 ====================

  /**
   * 显示进度条
   */
  private showProgress(current: number, total: number, text: string): void {
    this.hideProgress();

    const el = document.createElement('div');
    el.id = 'book-cacher-progress';
    el.innerHTML = `
      <div style="
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.88);
        color: white;
        padding: 16px 24px;
        border-radius: 12px;
        font-size: 13px;
        z-index: 99999;
        min-width: 320px;
        max-width: 420px;
        backdrop-filter: blur(12px);
        box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      ">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span id="bc-title" style="font-weight: 600;">📥 缓存书籍</span>
          <span id="bc-count" style="opacity: 0.7;">${current}/${total}</span>
        </div>
        <div style="
          background: rgba(255,255,255,0.15);
          border-radius: 4px;
          height: 6px;
          overflow: hidden;
          margin-bottom: 8px;
        ">
          <div id="bc-bar" style="
            background: linear-gradient(90deg, #4CAF50, #8BC34A);
            height: 100%;
            width: ${total > 0 ? (current / total * 100) : 0}%;
            border-radius: 4px;
            transition: width 0.3s ease;
          "></div>
        </div>
        <div id="bc-text" style="opacity: 0.6; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${text}
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this.progressEl = el;
  }

  /**
   * 更新进度条
   */
  private updateProgress(current: number, total: number, text: string): void {
    const countEl = document.getElementById('bc-count');
    const barEl = document.getElementById('bc-bar');
    const textEl = document.getElementById('bc-text');

    if (countEl) countEl.textContent = `${current}/${total}`;
    if (barEl) barEl.style.width = `${(current / total * 100)}%`;
    if (textEl) textEl.textContent = text;
  }

  /**
   * 隐藏进度条
   */
  private hideProgress(): void {
    const el = document.getElementById('book-cacher-progress');
    if (el) el.remove();
    this.progressEl = null;
  }

  /**
   * 显示缓存结果
   */
  private showResult(
    success: number,
    failed: number,
    total: number,
    totalSize: number
  ): void {
    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
    const emoji = failed === 0 ? '✅' : '⚠️';

    const el = document.createElement('div');
    el.id = 'book-cacher-result';
    el.innerHTML = `
      <div style="
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.88);
        color: white;
        padding: 16px 24px;
        border-radius: 12px;
        font-size: 13px;
        z-index: 99999;
        min-width: 320px;
        max-width: 420px;
        backdrop-filter: blur(12px);
        box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        animation: bcFadeIn 0.3s ease;
      ">
        <div style="font-weight: 600; margin-bottom: 8px; font-size: 14px;">
          ${emoji} 缓存完成
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; opacity: 0.8; font-size: 12px;">
          <span>📖 成功: ${success}/${total} 章</span>
          <span>💾 大小: ${sizeMB} MB</span>
          ${failed > 0 ? `<span>❌ 失败: ${failed} 章</span>` : ''}
          <span>📶 离线可用</span>
        </div>
        <div style="margin-top: 10px; opacity: 0.5; font-size: 11px; text-align: center;">
          现在可以离线阅读此书 · 3秒后关闭
        </div>
      </div>
    `;

    // 添加动画样式
    if (!document.getElementById('bc-anim-style')) {
      const style = document.createElement('style');
      style.id = 'bc-anim-style';
      style.textContent = `
        @keyframes bcFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes bcFadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(el);

    // 3秒后自动消失
    setTimeout(() => {
      const inner = el.querySelector('div') as HTMLElement;
      if (inner) inner.style.animation = 'bcFadeOut 0.5s ease forwards';
      setTimeout(() => el.remove(), 500);
    }, 3000);
  }

  /**
   * 显示简单Toast
   */
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
      ">
        ${message}
      </div>
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public destroy(): void {
    this.hideProgress();
    this.isCaching = false;
  }
}
