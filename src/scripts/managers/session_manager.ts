/**
 * Session Manager - 阅读会话管理
 * 
 * 责任:
 * - 保存阅读位置 (URL + 滚动位置 + 时间戳)
 * - 定期自动保存 (每5秒)
 * - 应用启动时恢复阅读位置
 * - 处理后台/前台切换
 */

import { log } from '../core/logger';
import { settingsStore, MergedSettings } from '../core/settings_store';
import { createSiteContext } from '../core/site_context';
import { invoke } from '@tauri-apps/api/tauri';

interface SessionData {
  url: string;
  scrollY: number;
  scrollX: number;
  timestamp: number;
  chapterId?: string;
  bookId?: string;
}

export class SessionManager {
  private saveInterval: number | null = null;
  private siteContext = createSiteContext();
  private readonly SAVE_INTERVAL_MS = 5000; // 每5秒保存一次
  private lastSavedSession: SessionData | null = null;

  constructor() {
    this.init();
  }

  private init() {
    log.info('[SessionManager] 初始化会话管理系统');

    // 启动自动保存
    this.startAutoSave();

    // 监听页面变化
    window.addEventListener('scroll', () => this.handleScroll(), { passive: true });
    window.addEventListener('popstate', () => this.handleRouteChange());
    
    // 监听应用切换
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
    
    // 监听应用退出
    window.addEventListener('beforeunload', () => this.handleBeforeUnload());

    log.info('[SessionManager] 会话管理系统已初始化');
  }

  private startAutoSave() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }

    this.saveInterval = window.setInterval(() => {
      this.saveSession();
    }, this.SAVE_INTERVAL_MS);
  }

  private handleScroll() {
    // 滚动时标记需要更新
    // 实际保存由 startAutoSave 定期执行
  }

  private handleRouteChange() {
    // 路由变化时立即保存
    this.saveSession();
  }

  private handleVisibilityChange() {
    if (document.hidden) {
      // 应用进入后台
      log.debug('[SessionManager] 应用进入后台，保存会话');
      this.saveSession();
    } else {
      // 应用返回前台
      log.debug('[SessionManager] 应用返回前台，恢复会话');
      this.restoreSession();
    }
  }

  private handleBeforeUnload() {
    // 应用关闭前保存
    log.info('[SessionManager] 应用关闭，保存会话');
    this.saveSession();
  }

  private saveSession() {
    const url = window.location.href;
    const scrollY = window.scrollY || 0;
    const scrollX = window.scrollX || 0;

    // 如果内容没有变化，就不必重复保存
    if (this.lastSavedSession) {
      if (
        this.lastSavedSession.url === url &&
        Math.abs(this.lastSavedSession.scrollY - scrollY) < 50
      ) {
        return; // 跳过保存
      }
    }

    const session: SessionData = {
      url,
      scrollY,
      scrollX,
      timestamp: Date.now(),
      chapterId: this.extractChapterId(),
      bookId: this.extractBookId(),
    };

    this.lastSavedSession = session;

    // 保存到本地存储
    try {
      const key = this.getSessionKey();
      sessionStorage.setItem(key, JSON.stringify(session));
      
      // 同时保存到设置中作为备份
      settingsStore.update({
        lastReaderUrl: url,
        lastScrollY: scrollY,
        lastScrollX: scrollX,
        lastSessionTime: Date.now(),
      });

      log.debug('[SessionManager] 会话已保存', {
        url: url.substring(0, 50),
        scrollY,
        timestamp: new Date(session.timestamp).toISOString(),
      });
    } catch (error) {
      log.error('[SessionManager] 保存会话失败:', error);
    }
  }

  private getSessionKey(): string {
    return `weread_session_${window.location.hostname}`;
  }

  private restoreSession() {
    try {
      const key = this.getSessionKey();
      const stored = sessionStorage.getItem(key);

      if (stored) {
        const session: SessionData = JSON.parse(stored);
        const timeSinceClose = Date.now() - session.timestamp;

        // 只在30分钟内恢复
        if (timeSinceClose < 30 * 60 * 1000) {
          log.debug('[SessionManager] 恢复会话', {
            timeSince: `${Math.round(timeSinceClose / 1000)}秒`,
            scrollY: session.scrollY,
          });

          // 使用 setTimeout 确保DOM已加载
          setTimeout(() => {
            this.restoreScrollPosition(session.scrollY, session.scrollX);
          }, 1000);

          return;
        } else {
          log.debug('[SessionManager] 会话已过期');
        }
      }

      // 尝试从settings恢复
      const settings = settingsStore.get();
      if (settings.lastScrollY !== undefined && settings.lastScrollY > 0) {
        log.debug('[SessionManager] 从settings恢复滚动位置:', settings.lastScrollY);
        setTimeout(() => {
          this.restoreScrollPosition(settings.lastScrollY!, settings.lastScrollX || 0);
        }, 1000);
      }
    } catch (error) {
      log.error('[SessionManager] 恢复会话失败:', error);
    }
  }

  private restoreScrollPosition(scrollY: number, scrollX: number) {
    try {
      // 方法1: 直接设置
      window.scrollTo(scrollX, scrollY);

      // 方法2: 如果是单栏模式，尝试定位元素
      if (scrollY > 0) {
        const reader = document.querySelector('[class*="reader"]');
        if (reader && reader.scrollHeight > 0) {
          (reader as HTMLElement).scrollTop = scrollY;
        }
      }

      log.info('[SessionManager] 滚动位置已恢复:', { scrollY, scrollX });
    } catch (error) {
      log.error('[SessionManager] 恢复滚动位置失败:', error);
    }
  }

  private extractChapterId(): string | undefined {
    const match = window.location.href.match(/ebook\/(\d+)/);
    return match?.[1];
  }

  private extractBookId(): string | undefined {
    const match = window.location.href.match(/bookId[=&]?(\d+)/);
    return match?.[1];
  }

  public clearSession() {
    try {
      const key = this.getSessionKey();
      sessionStorage.removeItem(key);
      this.lastSavedSession = null;
      log.debug('[SessionManager] 会话已清除');
    } catch (error) {
      log.error('[SessionManager] 清除会话失败:', error);
    }
  }

  public destroy() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveSession(); // 最后保存一次
  }
}
