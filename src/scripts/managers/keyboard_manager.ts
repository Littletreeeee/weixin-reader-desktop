/**
 * Keyboard Manager - 快捷键系统
 * 
 * 快捷键列表:
 * → (右箭头) - 下一页
 * ← (左箭头) - 上一页
 * Space - 下一页
 * Shift+Space - 上一页
 * B - 返回书架
 * M - 显示/隐藏菜单
 * A - 自动翻页开关
 * D - 深色模式切换
 * + - 字体放大
 * - - 字体缩小
 */

import { log } from '../core/logger';
import { settingsStore, MergedSettings } from '../core/settings_store';
import { createSiteContext } from '../core/site_context';

export class KeyboardManager {
  private enabled = true;
  private siteContext = createSiteContext();
  private lastKeyTime = 0;
  private keyDebounceMs = 100; // 防止快速重复按键

  constructor() {
    this.init();
  }

  private init() {
    log.info('[KeyboardManager] 初始化快捷键系统');
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
  }

  private shouldIgnoreKey(): boolean {
    const now = Date.now();
    if (now - this.lastKeyTime < this.keyDebounceMs) {
      return true;
    }
    this.lastKeyTime = now;
    return false;
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (!this.enabled || this.shouldIgnoreKey()) return;

    // 检查是否在输入框中
    const target = e.target as HTMLElement;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') {
      return;
    }

    const key = e.key.toLowerCase();
    const shift = e.shiftKey;
    const cmd = e.metaKey || e.ctrlKey;

    try {
      switch (key) {
        // 翻页快捷键
        case 'arrowright':
          e.preventDefault();
          this.nextPage();
          log.debug('[KeyboardManager] 右箭头: 下一页');
          break;

        case 'arrowleft':
          e.preventDefault();
          this.prevPage();
          log.debug('[KeyboardManager] 左箭头: 上一页');
          break;

        case ' ':
          e.preventDefault();
          if (shift) {
            this.prevPage();
            log.debug('[KeyboardManager] Shift+Space: 上一页');
          } else {
            this.nextPage();
            log.debug('[KeyboardManager] Space: 下一页');
          }
          break;

        // 功能快捷键
        case 'b':
          e.preventDefault();
          this.goBackToShelf();
          log.debug('[KeyboardManager] B: 返回书架');
          break;

        case 'm':
          e.preventDefault();
          this.toggleMenu();
          log.debug('[KeyboardManager] M: 切换菜单');
          break;

        case 'a':
          e.preventDefault();
          this.toggleAutoFlip();
          log.debug('[KeyboardManager] A: 切换自动翻页');
          break;

        case 'd':
          e.preventDefault();
          this.toggleDarkMode();
          log.debug('[KeyboardManager] D: 切换深色模式');
          break;

        // 字体大小调整
        case '+':
        case '=':
          if (cmd) {
            e.preventDefault();
            this.increaseFontSize();
            log.debug('[KeyboardManager] Cmd+Plus: 字体放大');
          }
          break;

        case '-':
          if (cmd) {
            e.preventDefault();
            this.decreaseFontSize();
            log.debug('[KeyboardManager] Cmd+Minus: 字体缩小');
          }
          break;

        case '0':
          if (cmd) {
            e.preventDefault();
            this.resetFontSize();
            log.debug('[KeyboardManager] Cmd+0: 字体重置');
          }
          break;
      }
    } catch (error) {
      log.error('[KeyboardManager] 快捷键处理错误:', error);
    }
  }

  private nextPage() {
    const plugin = (window as any).currentReaderPlugin;
    if (plugin?.nextPage) {
      plugin.nextPage();
    } else {
      // 备用: 触发官方快捷键
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          code: 'ArrowRight',
          keyCode: 39,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  private prevPage() {
    const plugin = (window as any).currentReaderPlugin;
    if (plugin?.prevPage) {
      plugin.prevPage();
    } else {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          keyCode: 37,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  private goBackToShelf() {
    window.history.back();
  }

  private toggleMenu() {
    const navbar = document.querySelector('[class*="navbar"]') ||
                   document.querySelector('.sidenav');
    
    if (navbar) {
      const isHidden = (navbar as HTMLElement).style.display === 'none' ||
                      window.getComputedStyle(navbar).display === 'none';
      (navbar as HTMLElement).style.display = isHidden ? 'block' : 'none';
    }
  }

  private toggleAutoFlip() {
    const settings = settingsStore.get();
    const currentState = settings.autoFlip?.active ?? false;
    
    settingsStore.update({
      autoFlip: {
        active: !currentState,
        interval: settings.autoFlip?.interval ?? 30,
        keepAwake: settings.autoFlip?.keepAwake ?? true,
      }
    });

    this.showToast(!currentState ? '自动翻页 已开启' : '自动翻页 已关闭');
  }

  private toggleDarkMode() {
    const settings = settingsStore.get();
    const currentState = settings.darkMode ?? false;
    
    settingsStore.update({
      darkMode: !currentState
    });

    this.showToast(!currentState ? '深色模式 已开启' : '深色模式 已关闭');
  }

  private increaseFontSize() {
    const settings = settingsStore.get();
    const current = settings.fontSize ?? 16;
    const newSize = Math.min(current + 2, 28);
    
    settingsStore.update({ fontSize: newSize });
    this.showToast(`字体大小: ${newSize}px`);
  }

  private decreaseFontSize() {
    const settings = settingsStore.get();
    const current = settings.fontSize ?? 16;
    const newSize = Math.max(current - 2, 12);
    
    settingsStore.update({ fontSize: newSize });
    this.showToast(`字体大小: ${newSize}px`);
  }

  private resetFontSize() {
    settingsStore.update({ fontSize: 16 });
    this.showToast('字体大小已重置');
  }

  private showToast(message: string) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 12px 24px;
      border-radius: 4px;
      font-size: 14px;
      z-index: 10000;
      animation: fadeInOut 2s ease-in-out;
    `;
    
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fadeInOut {
        0% { opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 1; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(toast);
    
    setTimeout(() => toast.remove(), 2000);
  }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    log.debug(`[KeyboardManager] 快捷键系统 ${enabled ? '已启用' : '已禁用'}`);
  }

  public destroy() {
    this.enabled = false;
  }
}
