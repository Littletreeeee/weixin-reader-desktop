/**
 * BookCacher - 一键缓存整本书（从 AI 大纲提取）
 *
 * 微信读书用 canvas 渲染正文，DOM 中没有纯文本。
 * 但 AI 大纲面板包含整本书的摘要/内容，可以从中提取。
 *
 * 使用方式：
 * 1. 打开一本书
 * 2. 点击左侧「AI大纲」打开大纲面板
 * 3. 按 Cmd+S 一键缓存
 *
 * Cmd+D: 调试 DOM 结构
 */

import { log } from '../core/logger';
import { invoke } from '@tauri-apps/api/core';

export class BookCacher {

  constructor() {
    this.bindShortcut();
    log.info('[BookCacher] 初始化完成 (Cmd+S 缓存, Cmd+D 调试DOM)');
  }

  private bindShortcut(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();

      if (key === 'd') {
        e.preventDefault();
        this.dumpDOM();
      }

      if (key === 's') {
        e.preventDefault();
        this.cacheBook();
      }
    });
  }

  // ==================== 一键缓存 ====================

  async cacheBook(): Promise<void> {
    if (!window.location.pathname.includes('/web/reader/')) {
      this.showToast('📖 请先打开一本书');
      return;
    }

    const bookIdMatch = window.location.pathname.match(/\/web\/reader\/([^/]+)/);
    if (!bookIdMatch) { this.showToast('❌ 无法识别书籍'); return; }
    const bookId = bookIdMatch[1];
    const bookTitle = this.getBookTitle();

    this.showToast(`📡 正在提取「${bookTitle}」...`);

    // 提取 AI 大纲内容
    const chapters = this.extractFromOutline();

    if (chapters.length === 0) {
      this.showToast('❌ 未找到内容。请先点击左侧「AI大纲」打开面板，再按 Cmd+S');
      return;
    }

    // 保存
    let success = 0;
    for (let i = 0; i < chapters.length; i++) {
      try {
        await invoke('save_book_cache', {
          bookId,
          chapterId: String(i),
          title: chapters[i].title,
          content: chapters[i].content,
        });
        success++;
      } catch (e) {
        log.warn(`[BookCacher] 保存失败: ${chapters[i].title}`, e);
      }
    }

    // 保存书名
    try {
      await invoke('save_book_cache', {
        bookId,
        chapterId: '__bookinfo__',
        title: bookTitle,
        content: JSON.stringify({ bookTitle, totalChapters: chapters.length, cachedAt: Date.now() }),
      });
    } catch (e) {}

    this.showToast(`✅ 缓存完成！${success}/${chapters.length}节\n离线可阅读「${bookTitle}」`);
    log.info(`[BookCacher] 缓存完成: ${bookTitle} ${success}/${chapters.length}节`);
  }

  // ==================== 从 AI 大纲提取 ====================

  private extractFromOutline(): { title: string; content: string }[] {
    const chapters: { title: string; content: string }[] = [];

    // 方案1: 从大纲的各个条目中提取
    const items = document.querySelectorAll('.outline_section_item_wrapper');
    
    if (items.length > 0) {
      items.forEach((item, idx) => {
        const el = item as HTMLElement;
        
        // 获取标题
        const titleEl = el.querySelector(
          '.outline_section_item_title_text, .outline_section_item_title, [class*="item_title"]'
        );
        
        // 获取内容
        const contentEl = el.querySelector(
          '.outline_section_item_content_text_content, .outline_section_item_content_text, .outline_section_item_content, [class*="item_content"]'
        );

        const title = titleEl?.textContent?.trim() || '';
        const content = (contentEl as HTMLElement)?.innerText?.trim() || '';

        if (content.length > 20) {
          chapters.push({
            title: title || `第${idx + 1}节`,
            content,
          });
        }
      });

      if (chapters.length > 0) return chapters;
    }

    // 方案2: 从整个大纲容器提取并分段
    const wrapper = document.querySelector(
      '.wr_ai_outline_book_detail_wrapper, .fake_scroll_bar_wrapper, [class*="outline_book_detail"]'
    );

    if (wrapper) {
      const fullText = (wrapper as HTMLElement).innerText?.trim() || '';
      if (fullText.length > 200) {
        // 按双换行分段
        const sections = fullText.split(/\n{2,}/).filter(s => s.trim().length > 30);
        for (let i = 0; i < sections.length; i++) {
          chapters.push({
            title: `第${i + 1}节`,
            content: sections[i].trim(),
          });
        }
      }
    }

    return chapters;
  }

  // ==================== 工具 ====================

  private getBookTitle(): string {
    const t = document.title;
    if (t && t.includes(' - ')) return t.split(' - ')[0].trim();
    if (t && !t.includes('微信读书')) return t.trim();
    return '未知书名';
  }

  private showToast(msg: string): void {
    document.getElementById('bc-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'bc-toast';
    el.innerHTML = `<div style="
      position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:rgba(0,0,0,0.9);color:white;padding:14px 22px;
      border-radius:10px;font-size:13px;z-index:99999;
      backdrop-filter:blur(8px);font-family:-apple-system,sans-serif;
      box-shadow:0 4px 20px rgba(0,0,0,0.4);max-width:400px;
      line-height:1.6;text-align:center;white-space:pre-line;
    ">${msg}</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  private dumpDOM(): void {
    const info: string[] = [];
    info.push(`URL: ${window.location.href}`);
    info.push(`Title: ${document.title}`);
    info.push('');
    info.push('=== 所有包含>100字文本的元素 ===');
    
    const seen = new Set<string>();
    document.querySelectorAll('*').forEach(el => {
      const htmlEl = el as HTMLElement;
      const text = htmlEl.innerText?.trim() || '';
      if (text.length > 100 && htmlEl.children.length < 20) {
        const cls = htmlEl.className
          ? `.${htmlEl.className.toString().split(/\s+/).slice(0, 3).join('.')}`
          : '';
        const key = `${htmlEl.tagName}${cls}`;
        if (!seen.has(key)) {
          seen.add(key);
          info.push(`${htmlEl.tagName}${cls} | children=${htmlEl.children.length} | text=${text.length}字 | 前60字="${text.substring(0, 60)}"`);
        }
      }
    });

    const overlay = document.createElement('div');
    overlay.id = 'dom-dump';
    overlay.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;z-index:999999;
      background:rgba(0,0,0,0.92);color:#0f0;font-family:monospace;
      font-size:11px;padding:20px;overflow:auto;white-space:pre-wrap;
    `;
    overlay.textContent = info.join('\n');
    overlay.onclick = () => overlay.remove();
    navigator.clipboard?.writeText(info.join('\n')).catch(() => {});
    document.body.appendChild(overlay);
  }

  public destroy(): void {}
}
