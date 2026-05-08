/**
 * Security Checker - 安全性检查模块
 * 
 * 防止:
 * - 恶意脚本注入
 * - 敏感信息泄露
 * - 非法网络请求
 */

import { log } from './logger';

interface SecurityCheckResult {
  passed: boolean;
  warnings: string[];
  errors: string[];
}

export class SecurityChecker {
  private static readonly ALLOWED_DOMAINS = [
    'weread.qq.com',
    'localhost',
    '127.0.0.1',
  ];

  private static readonly BLOCKED_KEYWORDS = [
    'localStorage.clear()',
    'sessionStorage.clear()',
    'document.cookie',
  ];

  /**
   * 检查URL是否安全
   */
  static checkUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;

      // 检查是否是允许的域名
      const isAllowed = this.ALLOWED_DOMAINS.some(domain => {
        return hostname.endsWith(domain) || hostname === domain;
      });

      if (!isAllowed) {
        log.warn('[SecurityChecker] 检测到非法域名:', hostname);
        return false;
      }

      return true;
    } catch (error) {
      log.error('[SecurityChecker] URL 解析失败:', error);
      return false;
    }
  }

  /**
   * 检查脚本内容是否安全
   */
  static checkScriptContent(content: string): SecurityCheckResult {
    const result: SecurityCheckResult = {
      passed: true,
      warnings: [],
      errors: [],
    };

    // 检查危险关键字
    for (const keyword of this.BLOCKED_KEYWORDS) {
      if (content.includes(keyword)) {
        result.passed = false;
        result.errors.push(`检测到危险操作: ${keyword}`);
      }
    }

    // 检查 eval 函数
    if (content.includes('eval(') || content.includes('Function(')) {
      result.warnings.push('检测到潜在的动态代码执行');
    }

    // 检查不安全的 DOM 操作
    if (content.match(/innerHTML\s*=|insertAdjacentHTML/)) {
      result.warnings.push('检测到 innerHTML 操作，请确保内容受控');
    }

    return result;
  }

  /**
   * 检查 HTTP 请求是否安全
   */
  static checkHttpRequest(
    url: string,
    method: string = 'GET',
    headers?: Record<string, string>
  ): SecurityCheckResult {
    const result: SecurityCheckResult = {
      passed: true,
      warnings: [],
      errors: [],
    };

    // 检查 URL
    if (!this.checkUrl(url)) {
      result.passed = false;
      result.errors.push(`不允许的URL: ${url}`);
    }

    // 检查是否包含敏感信息在URL中
    if (url.includes('password=') || url.includes('token=') || url.includes('secret=')) {
      result.passed = false;
      result.errors.push('检测到 URL 中的敏感信息');
    }

    // 检查 headers 中的敏感信息
    if (headers) {
      const sensitiveHeaders = ['authorization', 'x-api-key', 'x-secret'];
      for (const key of Object.keys(headers)) {
        if (sensitiveHeaders.includes(key.toLowerCase())) {
          // Headers 中的敏感信息是正常的，但要确保只发送到安全的域名
          const urlObj = new URL(url);
          if (!urlObj.hostname.endsWith('weread.qq.com')) {
            result.warnings.push(`在非官方域名中检测到敏感 header: ${key}`);
          }
        }
      }
    }

    return result;
  }

  /**
   * 检查本地存储是否安全
   */
  static checkLocalStorage(): SecurityCheckResult {
    const result: SecurityCheckResult = {
      passed: true,
      warnings: [],
      errors: [],
    };

    try {
      // 检查敏感数据
      const sensitiveKeys = ['password', 'token', 'secret', 'apiKey'];
      
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          for (const sensitive of sensitiveKeys) {
            if (key.toLowerCase().includes(sensitive)) {
              result.warnings.push(`检测到本地存储中的敏感数据: ${key}`);
            }
          }
        }
      }

      return result;
    } catch (error) {
      result.errors.push(`本地存储检查失败: ${error}`);
      return result;
    }
  }

  /**
   * 执行全面安全检查
   */
  static performFullCheck(): SecurityCheckResult {
    const results = [
      this.checkLocalStorage(),
    ];

    const combined: SecurityCheckResult = {
      passed: results.every(r => r.passed),
      warnings: results.flatMap(r => r.warnings),
      errors: results.flatMap(r => r.errors),
    };

    if (combined.errors.length > 0) {
      log.error('[SecurityChecker] 安全检查失败:', combined.errors);
    }

    if (combined.warnings.length > 0) {
      log.warn('[SecurityChecker] 安全警告:', combined.warnings);
    }

    log.info('[SecurityChecker] 安全检查完成', {
      passed: combined.passed,
      warnings: combined.warnings.length,
      errors: combined.errors.length,
    });

    return combined;
  }

  /**
   * 拦截并检查网络请求
   */
  static interceptFetch() {
    const originalFetch = window.fetch;

    (window as any).fetch = function(...args: any[]): Promise<Response> {
      const [resource, config] = args;
      const url = typeof resource === 'string' ? resource : resource.url;

      // 检查请求安全性
      const check = SecurityChecker.checkHttpRequest(
        url,
        (config?.method || 'GET').toUpperCase(),
        config?.headers
      );

      if (!check.passed) {
        log.error('[SecurityChecker] 阻止不安全的请求:', url);
        return Promise.reject(new Error(`Security check failed: ${check.errors.join(', ')}`));
      }

      return originalFetch.apply(this, args);
    };

    log.info('[SecurityChecker] Fetch 请求拦截已启用');
  }
}
