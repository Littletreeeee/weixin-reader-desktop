/**
 * 缓存拦截器 - 拦截HTTP请求并缓存响应
 * 离线时从缓存返回内容
 */

import { CacheManager } from '../managers/cache_manager';

class CacheInterceptor {
  private cacheManager: CacheManager;
  private originalFetch: typeof fetch;

  constructor() {
    this.cacheManager = CacheManager.getInstance();
    this.originalFetch = window.fetch;
    this.setupInterceptor();
  }

  /**
   * 设置 fetch 拦截器
   */
  private setupInterceptor(): void {
    const self = this;

    window.fetch = function (...args): Promise<Response> {
      const [resource, config] = args as any[];
      const url = typeof resource === 'string' ? resource : resource.url;

      // 只缓存 weread.qq.com 的请求
      if (!url.includes('weread.qq.com')) {
        return self.originalFetch.apply(window, args);
      }

      // 只缓存 GET 请求
      const method = config?.method || 'GET';
      if (method !== 'GET') {
        return self.originalFetch.apply(window, args);
      }

      console.log(`[CacheInterceptor] 拦截请求: ${url}`);

      // 如果在线，正常请求并缓存
      if (self.cacheManager.getNetworkStatus()) {
        return self.originalFetch
          .apply(window, args)
          .then(async (response: Response) => {
            // 只缓存成功的响应
            if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
              try {
                const cloned = response.clone();
                await self.cacheManager.cacheResponse(url, cloned);
              } catch (error) {
                console.warn('[CacheInterceptor] 缓存失败:', error);
              }
            }
            return response;
          })
          .catch(async (error: Error) => {
            console.log('[CacheInterceptor] 网络请求失败，尝试使用缓存', error);

            // 网络错误时尝试使用缓存
            const cached = await self.cacheManager.getFromCache(url);
            if (cached) {
              console.log('[CacheInterceptor] 使用缓存内容');
              return cached;
            }

            // 缓存也没有，抛出错误
            throw error;
          });
      }

      // 离线时直接使用缓存
      return self.cacheManager.getFromCache(url).then((cached) => {
        if (cached) {
          console.log('[CacheInterceptor] 离线模式 - 使用缓存');
          return cached;
        }

        // 缓存不存在，返回错误
        return new Response(
          JSON.stringify({
            error: '离线状态且无缓存',
            url,
          }),
          {
            status: 503,
            statusText: 'Service Unavailable',
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      });
    };

    console.log('[CacheInterceptor] Fetch 拦截器已启用');
  }

  /**
   * 禁用拦截器
   */
  disable(): void {
    window.fetch = this.originalFetch;
    console.log('[CacheInterceptor] 拦截器已禁用');
  }

  /**
   * 获取缓存统计
   */
  async getStats() {
    return this.cacheManager.getCacheStats();
  }

  /**
   * 清除缓存
   */
  async clearCache() {
    return this.cacheManager.clearAllCache();
  }
}

export { CacheInterceptor };
