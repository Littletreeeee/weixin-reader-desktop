/**
 * 缓存管理器 - 为书籍内容提供离线阅读支持
 * 功能: 自动缓存书籍内容，离线时从缓存读取
 */

class CacheManager {
  private static instance: CacheManager;
  private DB_NAME = 'weread-cache';
  private DB_VERSION = 1;
  private CACHE_STORE = 'books';
  private NETWORK_STORE = 'network-status';
  private db: IDBDatabase | null = null;
  private isOnline = navigator.onLine;
  private cacheSize = 100 * 1024 * 1024; // 100MB 缓存限制

  private constructor() {
    this.initDB();
    this.setupNetworkListener();
  }

  static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  /**
   * 初始化 IndexedDB
   */
  private initDB(): void {
    try {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => {
        console.warn('[CacheManager] Failed to open IndexedDB');
      };

      request.onsuccess = (event: any) => {
        this.db = event.target.result;
        console.log('[CacheManager] IndexedDB initialized');
      };

      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;

        // 创建书籍缓存store
        if (!db.objectStoreNames.contains(this.CACHE_STORE)) {
          const store = db.createObjectStore(this.CACHE_STORE, { keyPath: 'url' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('bookId', 'bookId', { unique: false });
        }

        // 创建网络状态store
        if (!db.objectStoreNames.contains(this.NETWORK_STORE)) {
          db.createObjectStore(this.NETWORK_STORE, { keyPath: 'status' });
        }

        console.log('[CacheManager] Database upgraded');
      };
    } catch (error) {
      console.error('[CacheManager] IndexedDB not available:', error);
    }
  }

  /**
   * 监听网络状态变化
   */
  private setupNetworkListener(): void {
    window.addEventListener('online', () => {
      this.isOnline = true;
      console.log('[CacheManager] 网络已连接');
      this.notifyNetworkStatus(true);
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      console.log('[CacheManager] 网络已断开 - 使用缓存阅读');
      this.notifyNetworkStatus(false);
    });
  }

  /**
   * 缓存HTTP响应
   */
  async cacheResponse(
    url: string,
    response: Response,
    metadata: {
      bookId?: string;
      chapterId?: string;
      title?: string;
    } = {}
  ): Promise<void> {
    if (!this.db) return;

    try {
      const clonedResponse = response.clone();
      const text = await clonedResponse.text();
      const size = new Blob([text]).size;

      // 检查缓存大小
      if (!(await this.hasEnoughSpace(size))) {
        await this.clearOldCache();
      }

      const cacheEntry = {
        url,
        content: text,
        contentType: response.headers.get('content-type'),
        timestamp: Date.now(),
        size,
        status: response.status,
        ...metadata,
      };

      const transaction = this.db.transaction([this.CACHE_STORE], 'readwrite');
      const store = transaction.objectStore(this.CACHE_STORE);
      await new Promise((resolve, reject) => {
        const request = store.put(cacheEntry);
        request.onsuccess = () => resolve(undefined);
        request.onerror = () => reject(request.error);
      });

      console.log(`[CacheManager] 缓存已保存: ${url}`);
    } catch (error) {
      console.error('[CacheManager] Failed to cache response:', error);
    }
  }

  /**
   * 从缓存读取
   */
  async getFromCache(url: string): Promise<Response | null> {
    if (!this.db) return null;

    try {
      const transaction = this.db.transaction([this.CACHE_STORE], 'readonly');
      const store = transaction.objectStore(this.CACHE_STORE);

      const entry = await new Promise<any>((resolve, reject) => {
        const request = store.get(url);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      if (!entry) {
        console.log(`[CacheManager] 缓存未找到: ${url}`);
        return null;
      }

      console.log(`[CacheManager] 从缓存读取: ${url}`);

      // 创建Response对象
      return new Response(entry.content, {
        status: entry.status || 200,
        headers: {
          'Content-Type': entry.contentType || 'text/html',
          'X-From-Cache': 'true',
        },
      });
    } catch (error) {
      console.error('[CacheManager] Failed to get from cache:', error);
      return null;
    }
  }

  /**
   * 检查是否有足够的缓存空间
   */
  private async hasEnoughSpace(size: number): Promise<boolean> {
    if (!this.db) return false;

    try {
      const transaction = this.db.transaction([this.CACHE_STORE], 'readonly');
      const store = transaction.objectStore(this.CACHE_STORE);

      const allEntries = await new Promise<any[]>((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const totalSize = allEntries.reduce((sum, entry) => sum + (entry.size || 0), 0);
      return totalSize + size <= this.cacheSize;
    } catch (error) {
      console.error('[CacheManager] Failed to check cache space:', error);
      return true;
    }
  }

  /**
   * 清理旧缓存
   */
  private async clearOldCache(): Promise<void> {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction([this.CACHE_STORE], 'readwrite');
      const store = transaction.objectStore(this.CACHE_STORE);
      const index = store.index('timestamp');

      // 获取所有缓存，按时间排序
      const allEntries = await new Promise<any[]>((resolve, reject) => {
        const request = index.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      // 删除最旧的 20%
      const toDelete = Math.ceil(allEntries.length * 0.2);
      for (let i = 0; i < toDelete; i++) {
        store.delete(allEntries[i].url);
      }

      console.log(`[CacheManager] 已清理 ${toDelete} 个旧缓存`);
    } catch (error) {
      console.error('[CacheManager] Failed to clear old cache:', error);
    }
  }

  /**
   * 获取缓存统计信息
   */
  async getCacheStats(): Promise<{
    totalSize: number;
    entryCount: number;
    isOnline: boolean;
  }> {
    if (!this.db) {
      return { totalSize: 0, entryCount: 0, isOnline: this.isOnline };
    }

    try {
      const transaction = this.db.transaction([this.CACHE_STORE], 'readonly');
      const store = transaction.objectStore(this.CACHE_STORE);

      const allEntries = await new Promise<any[]>((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const totalSize = allEntries.reduce((sum, entry) => sum + (entry.size || 0), 0);

      return {
        totalSize,
        entryCount: allEntries.length,
        isOnline: this.isOnline,
      };
    } catch (error) {
      console.error('[CacheManager] Failed to get cache stats:', error);
      return { totalSize: 0, entryCount: 0, isOnline: this.isOnline };
    }
  }

  /**
   * 清除所有缓存
   */
  async clearAllCache(): Promise<void> {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction([this.CACHE_STORE], 'readwrite');
      const store = transaction.objectStore(this.CACHE_STORE);

      await new Promise((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve(undefined);
        request.onerror = () => reject(request.error);
      });

      console.log('[CacheManager] 所有缓存已清除');
    } catch (error) {
      console.error('[CacheManager] Failed to clear all cache:', error);
    }
  }

  /**
   * 清除特定书籍的缓存
   */
  async clearBookCache(bookId: string): Promise<void> {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction([this.CACHE_STORE], 'readwrite');
      const store = transaction.objectStore(this.CACHE_STORE);
      const index = store.index('bookId');

      const entries = await new Promise<any[]>((resolve, reject) => {
        const request = index.getAll(bookId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      entries.forEach(entry => store.delete(entry.url));

      console.log(`[CacheManager] 已清除书籍 ${bookId} 的缓存`);
    } catch (error) {
      console.error('[CacheManager] Failed to clear book cache:', error);
    }
  }

  /**
   * 获取网络状态
   */
  getNetworkStatus(): boolean {
    return this.isOnline;
  }

  /**
   * 通知网络状态变化
   */
  private notifyNetworkStatus(isOnline: boolean): void {
    // 发送事件到UI层
    window.dispatchEvent(
      new CustomEvent('cacheNetworkStatusChanged', {
        detail: { isOnline },
      })
    );
  }

  /**
   * 预缓存书籍（可选）
   */
  async preCacheBook(bookId: string, urls: string[]): Promise<void> {
    console.log(`[CacheManager] 开始预缓存书籍 ${bookId}，共 ${urls.length} 个资源`);

    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          await this.cacheResponse(url, response, { bookId });
        }
      } catch (error) {
        console.warn(`[CacheManager] 预缓存失败: ${url}`, error);
      }
    }

    console.log(`[CacheManager] 书籍 ${bookId} 预缓存完成`);
  }
}

export { CacheManager };
