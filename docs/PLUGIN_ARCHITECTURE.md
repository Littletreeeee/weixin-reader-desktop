# 插件化架构设计文档

本文档介绍微信读书桌面客户端的插件化架构，为第三方开发者提供插件开发指南。

> **版本历史**
> - v0.8.0: 引入插件化架构，支持 .atrd 插件包安装/卸载
> - v0.9.0: 新增可视化插件编辑器，支持应用内创建和编辑插件

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         Tauri 应用层                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    插件系统 (Plugin System)               │  │
│  │                                                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │  │
│  │  │ PluginLoader │  │PluginManager│  │  PluginAPI  │     │  │
│  │  │  插件加载器   │  │  插件管理器   │  │  插件接口   │     │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘     │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐  │
│  │   WeRead 插件    │ │   未来: 本地    │ │  第三方插件      │  │
│  │   (内置默认)     │ │   EPUB/TXT     │ │  (.atrd 安装)    │  │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 可安装插件系统

### 1. 插件包格式 (.atrd)

`.atrd` (AT Reader Data) 是艾特阅读专用的插件安装包格式，本质是 ZIP 压缩文件。

**选用理由**：避免与浏览器插件格式（.crx, .xpi）、常见压缩格式（.zip）产生混淆。

#### 包结构

```
my-plugin.atrd (ZIP)
├── manifest.json      # 必须：插件清单文件
├── plugin.js          # 必须：插件脚本（打包后）
├── icon.png           # 可选：插件图标（64x64 推荐）
└── assets/            # 可选：其他资源文件
    ├── style.css
    └── ...
```

### 2. manifest.json 完整规范

```json
{
  "id": "example-plugin",
  "name": "示例插件",
  "version": "1.0.0",
  "description": "插件功能描述",
  "author": "开发者名称",
  "sourceType": "script",
  
  "site": {
    "domain": "example.com",
    "homeUrl": "https://example.com/",
    "readerPattern": "/reader/"
  },
  
  "capabilities": {
    "script": true,
    "wideMode": false,
    "hideToolbar": false,
    "autoFlip": false
  },
  
  "configSchema": {
    "enableFeature": {
      "type": "boolean",
      "default": false,
      "label": "启用功能",
      "description": "详细说明（可选）"
    },
    "customValue": {
      "type": "string",
      "default": "",
      "label": "自定义值"
    },
    "advancedOption": {
      "type": "boolean",
      "default": false,
      "label": "高级选项",
      "condition": "enableFeature"
    }
  }
}
```

#### 字段说明

| 字段 | 必须 | 类型 | 说明 |
|------|------|------|------|
| `id` | ✅ | string | 插件唯一标识，用于存储和引用 |
| `name` | ✅ | string | 插件显示名称 |
| `version` | ✅ | string | 语义化版本号 (semver) |
| `description` | ❌ | string | 插件功能描述 |
| `author` | ❌ | string | 开发者名称 |
| `sourceType` | ✅ | string | 插件类型：`script` / `web` / `local` |
| `site` | ❌ | object | 网站配置（用于帮助菜单入口） |
| `site.domain` | ❌ | string/string[] | 匹配的域名 |
| `site.homeUrl` | ❌ | string | 网站首页 URL（显示在帮助菜单） |
| `site.readerPattern` | ❌ | string | 阅读页 URL 模式 |
| `capabilities` | ❌ | object | 插件声明的能力 |
| `configSchema` | ❌ | object | 配置项定义（自动生成设置 UI） |

#### configSchema 字段类型

| type | 说明 | 额外字段 |
|------|------|---------|
| `boolean` | 开关切换 | - |
| `string` | 文本输入 | - |
| `number` | 数字输入 | - |
| `select` | 下拉选择 | `options: [{value, label}]` |

**condition 字段**：可选，指定另一个配置项的 key，当该配置项为 true 时才显示此项。

### 3. 插件存储位置

安装后的插件存储在用户数据目录：

```
{APP_CONFIG_DIR}/
├── settings.json          # 应用设置（含 pluginConfigs）
└── plugins/               # 插件目录
    ├── example-plugin/    # 每个插件独立目录
    │   ├── manifest.json
    │   └── plugin.js
    └── another-plugin/
        └── ...
```

**配置存储结构** (settings.json)：

```json
{
  "global": { ... },
  "sites": { ... },
  "pluginConfigs": {
    "example-plugin": {
      "enableFeature": true,
      "customValue": "hello"
    }
  }
}
```

---

## 后端 API (Rust)

### 核心模块：plugin_manager.rs

路径：`src-tauri/src/plugin_manager.rs`

```rust
// 从 .atrd 文件安装插件
pub fn install_plugin_from_file<R: Runtime>(
    app: &AppHandle<R>, 
    file_path: &str
) -> Result<PluginInfo, String>

// 卸载插件
pub fn uninstall_plugin<R: Runtime>(
    app: &AppHandle<R>, 
    plugin_id: &str
) -> Result<(), String>

// 获取所有已安装的外部插件
pub fn get_installed_plugins<R: Runtime>(
    app: &AppHandle<R>
) -> Result<Vec<PluginInfo>, String>

// 读取插件配置
pub fn get_plugin_config<R: Runtime>(
    app: &AppHandle<R>, 
    plugin_id: &str
) -> Result<Value, String>

// 保存插件配置
pub fn save_plugin_config<R: Runtime>(
    app: &AppHandle<R>, 
    plugin_id: &str, 
    config: Value
) -> Result<(), String>

// 读取插件代码
pub fn get_plugin_code<R: Runtime>(
    app: &AppHandle<R>, 
    plugin_id: &str
) -> Result<String, String>
```

### Tauri 命令 (commands.rs)

前端通过 `invoke()` 调用：

```typescript
// 安装插件
await invoke('install_plugin', { path: '/path/to/plugin.atrd' });

// 卸载插件
await invoke('uninstall_plugin', { pluginId: 'example-plugin' });

// 获取已安装插件列表
const plugins = await invoke('get_installed_plugins');

// 获取插件配置
const config = await invoke('get_plugin_config', { pluginId: 'example-plugin' });

// 保存插件配置
await invoke('save_plugin_config', { 
  pluginId: 'example-plugin', 
  config: { enableFeature: true } 
});

// 获取插件代码
const code = await invoke('get_plugin_code', { pluginId: 'example-plugin' });
```

---

## 前端集成

### TypeScript 类型定义

路径：`src/scripts/core/plugin_types.ts`

```typescript
// 配置字段类型
export type ConfigFieldType = 'boolean' | 'string' | 'number' | 'select';

// 配置 Schema 字段定义
export interface ConfigSchemaField {
  type: ConfigFieldType;
  default: boolean | string | number;
  label: string;
  condition?: string;  // 条件显示
  options?: Array<{ value: string | number; label: string }>;  // select 选项
  description?: string;
}

// 完整配置 Schema
export type ConfigSchema = Record<string, ConfigSchemaField>;

// 已安装插件信息
export interface InstalledPluginInfo {
  id: string;
  version: string;
  installedAt: number;  // Unix 时间戳
  enabled: boolean;
  builtin?: boolean;
}

// 插件展示信息（合并 manifest + 状态）
export interface PluginDisplayInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  homeUrl?: string;
  builtin: boolean;
  enabled: boolean;
  capabilities: PluginCapabilities;
  configSchema?: ConfigSchema;
}
```

### 设置数据结构

路径：`src/scripts/core/settings_store.ts`

```typescript
export interface AppSettings {
  _version?: number;
  global?: {
    zoom?: number;
    autoUpdate?: boolean;
    lastPage?: boolean;
    hideCursor?: boolean;
    enabledPlugins?: string[];  // undefined = 全部启用
  };
  sites?: {
    [siteId: string]: SiteSettings;
  };
  pluginConfigs?: {  // 插件配置存储
    [pluginId: string]: Record<string, any>;
  };
}
```

### 设置界面 (settings.html)

插件管理界面实现要点：

1. **安装按钮**：使用 Tauri Dialog API 选择 .atrd 文件
2. **插件列表**：合并内置插件 + 外部插件
3. **配置面板**：根据 configSchema 自动生成 UI
4. **卸载按钮**：仅外部插件显示

```javascript
// 安装插件
document.getElementById('installPluginBtn').addEventListener('click', async () => {
  const { open } = tauri.dialog;
  const file = await open({
    multiple: false,
    filters: [{ name: 'AT Reader 插件', extensions: ['atrd'] }]
  });
  
  if (file) {
    await invoke('install_plugin', { path: file });
    // 刷新列表
    invoke('get_settings').then(renderPluginList);
  }
});

// 配置变更
async function handleConfigChange(e) {
  const input = e.target;
  const pluginId = input.dataset.plugin;
  const key = input.dataset.configKey;
  const value = input.checked;  // boolean 类型
  
  const currentConfig = await invoke('get_plugin_config', { pluginId });
  const newConfig = { ...currentConfig, [key]: value };
  await invoke('save_plugin_config', { pluginId, config: newConfig });
}
```

---

## 动态帮助菜单

### 实现原理

路径：`src-tauri/src/menu.rs`

插件安装后，若 manifest 包含 `site.homeUrl`，将自动在帮助菜单中添加入口：

```rust
// 获取插件网站入口
fn get_plugin_site_items<R: Runtime>(handle: &tauri::AppHandle<R>) -> Vec<PluginSiteMenuItem> {
    let mut items = Vec::new();
    
    if let Ok(plugins) = plugin_manager::get_installed_plugins(handle) {
        for plugin in plugins {
            if let Some(site) = plugin.site {
                items.push(PluginSiteMenuItem {
                    id: format!("plugin_site_{}", plugin.id),
                    name: plugin.name,
                    url: site.home_url,
                });
            }
        }
    }
    
    items
}
```

菜单重建时机：
- 应用启动时
- 窗口移动到其他显示器时（重建整个菜单）
- 插件安装/卸载后需手动重启应用

---

## 可视化插件编辑器 <sup>v0.9.0 新增</sup>

从 v0.9.0 开始，应用内置了可视化插件编辑器，无需外部 IDE 即可创建和编辑插件。

### 打开方式

```
设置 → 插件管理 → 新建插件
```

外部安装的插件也可以点击「编辑」按钮进行修改。

### 编辑器功能

| 区域 | 功能 |
|------|------|
| **左侧导航** | 基本信息、站点配置、功能能力、代码编辑、样式文件 |
| **中间表单** | 可视化配置插件属性 |
| **右侧预览** | 实时显示插件信息卡片 |

### 表单配置项

#### 基本信息
- 插件 ID（唯一标识，kebab-case 格式）
- 插件名称
- 版本号（semver 格式）
- 描述信息

#### 站点配置
- 源类型（Web 在线 / 本地文件）
- 目标域名
- 首页 URL
- 阅读页匹配模式
- 主页匹配模式

#### 功能能力
- 宽屏模式、深色模式
- 隐藏工具栏、隐藏导航栏
- 自动翻页、章节导航
- 进度追踪、双栏模式
- 隐藏光标、遥控器支持

### 代码编辑

编辑器支持多文件切换：

| 文件 | 用途 |
|------|------|
| `index.ts` | 插件主逻辑 |
| `wide.css` | 宽屏模式样式 |
| `toolbar.css` | 工具栏隐藏样式 |
| `theme.css` | 主题/深色模式样式 |

### 保存与安装

点击「保存并安装」按钮：
1. 编辑器将表单数据和代码打包为 `.atrd` 格式
2. 自动调用后端 API 安装插件
3. 插件立即出现在插件列表中

---

## 插件开发流程

### 1. 创建插件目录

```bash
mkdir my-plugin
cd my-plugin
```

### 2. 编写 manifest.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "插件功能说明",
  "sourceType": "script",
  "site": {
    "domain": "target-site.com",
    "homeUrl": "https://target-site.com/",
    "readerPattern": "/read/"
  },
  "configSchema": {
    "myOption": {
      "type": "boolean",
      "default": false,
      "label": "我的选项"
    }
  }
}
```

### 3. 编写 plugin.js

```javascript
(function() {
  console.log('[MyPlugin] 插件已加载');
  
  // 获取配置（如果有）
  const config = window.__PLUGIN_CONFIG__ || {};
  
  if (config.myOption) {
    // 执行功能
  }
  
  // 监听路由变化
  // 注入样式
  // 等等...
})();
```

### 4. 打包为 .atrd

```bash
zip -r my-plugin.atrd manifest.json plugin.js
# 或包含图标
zip -r my-plugin.atrd manifest.json plugin.js icon.png
```

### 5. 测试安装

1. 运行应用 `bun start`
2. 打开 设置 → 插件管理
3. 点击「安装插件」
4. 选择 `my-plugin.atrd`
5. 验证插件出现在列表中
6. 展开配置面板，验证选项
7. 检查帮助菜单是否有网站入口

---

## 核心概念

### 1. 插件类型 (SourceType)

| 类型 | 说明 | 渲染模式 | 示例 |
|------|------|---------|------|
| `script` | 脚本注入 | WebView | 第三方扩展 |
| `web` | 在线阅读网站 | WebView | 微信读书、豆瓣阅读 |
| `local` | 本地文件 | 自定义渲染 | EPUB、TXT（规划中） |

### 2. 插件能力 (Capabilities)

```typescript
interface PluginCapabilities {
  script?: boolean;        // 脚本注入
  wideMode?: boolean;      // 宽屏模式
  hideToolbar?: boolean;   // 隐藏工具栏
  hideNavbar?: boolean;    // 隐藏导航栏
  autoFlip?: boolean;      // 自动翻页
  chapterNav?: boolean;    // 章节导航
  progressTracker?: boolean; // 进度追踪
  hideCursor?: boolean;    // 隐藏光标
  remoteControl?: boolean; // 遥控器支持
}
```

---

## 内置插件: 微信读书

### 功能清单

| 功能 | 状态 | 说明 |
|------|------|------|
| 宽屏模式 | ✅ | 扩展阅读区域至全屏 |
| 隐藏工具栏 | ✅ | 隐藏顶部工具栏 |
| 隐藏导航栏 | ✅ | 双栏模式下隐藏底部导航 |
| 自动翻页 | ✅ | 单栏滚动/双栏定时翻页 |
| 进度追踪 | ✅ | 实时显示章节阅读进度 |
| 章节导航 | ✅ | 遥控器上下键切换章节 |
| 双栏检测 | ✅ | 自动检测双栏/单栏模式 |
| 光标隐藏 | ✅ | 静止后自动隐藏鼠标 |

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `←` / `→` | 上一页 / 下一页 |
| `↑` / `↓` | 上一章 / 下一章（遥控器） |

---

## 未来规划

### 本地阅读插件 (LocalReaderPlugin)

支持本地电子书格式：

- **EPUB**: 标准电子书格式
- **TXT**: 纯文本格式
- **MOBI**: Kindle 格式（可选）

### 第三方网站适配

开发者可基于插件模板适配其他阅读网站：

- 豆瓣阅读
- 起点读书
- 番茄小说
- 等等...

---

## 参考资料

- [Tauri v2 文档](https://v2.tauri.app/)
- [项目开发规范](../CLAUDE.md)
- [测试指南](./TESTING.md)
