# dsh-sidebar-reader

[English](README.md) | 中文

让模型按需读取**当前会话**的侧边栏：官方右侧栏标签、终端屏幕、浏览器网页正文。

装好后对模型说一句「读」或「看我开着的终端」，模型通过插件的命令通道触发一次采集，几秒内就能拿到快照。

## 工作原理

```
模型 ──POST /sidebar-reader/command──▶ 宿主路由 (lib/index.js)
                                          │ 客户端每 2s 轮询领命令
                                          ▼
                     客户端采集 (lib/client.js，跑在 Web UI 里)
                     ├── 官方右侧栏标签（sidebarRight.openTabs，按当前会话过滤）
                     ├── 终端屏幕（remote.terminal.attach，取首个全屏快照）
                     └── 网页正文（webview innerText，仅桌面端）
                                          │
                       客户端 ──POST /sidebar-reader/latest──▶ 宿主只保留最新一份
模型 ◀──GET /sidebar-reader/latest──── 宿主
```

## 模型工具（自动注册）

插件宿主侧会向 DSH 工具注册表注册一个原生 agent 工具 **`sidebar_read`**：每个新会话的工具清单里自动出现，模型**零参数一次调用**即拿到全量快照（网页正文 + 侧栏标签 + 终端屏幕），无需任何 HTTP 调用或配置。「读终端/网页先走侧边栏」的偏好直接编码在工具描述里。

下方 HTTP 端点保留为兜底通道。

## 功能

| 采集路 | 来源 | 说明 |
|---|---|---|
| 右侧栏标签 | `sidebarRight.openTabs` 活快照 | 文件 / 目录 / 文档 / 浏览器 / 终端标签，**只取当前会话** |
| 终端屏幕 | `remote.terminal.attach` 首帧快照 | 含滚动缓冲的完整屏幕；读完立即断开归还输入权 |
| 网页正文 | 侧栏浏览器 webview 的 `innerText` | **仅桌面端（Electron）**；纯浏览器里安静返回 null |

四条设计纪律：

1. **作用域**：所有数据先按「屏幕上的会话」过滤才出浏览器，别的会话读不到；
2. **永不抛错**：三路采集各自降级，一路坏了其余照常返回；
3. **透明**：每次读取界面都弹 toast，用户看得见；
4. **可撤销**：所有副作用挂在 `ctx.effect` 上，禁用插件即干净退场。

## 安装

```sh
# 插件市场（dshmarket 或官方发现页收录后）里搜索 Sidebar Reader
# 或命令行：
dsh plugin --profile <你的profile> add dsh-sidebar-reader
```

官方 DSH Desktop 桌面端请在应用自身的 **设置 → 插件** 里安装。

本地开发安装：把本仓库克隆到任意目录，用插件管理的「安装本地插件」指向该目录即可（pnpm link）。

## 要求

- **DSH >= 0.2.1-rc.2**（终端读取依赖 `remote.terminal.attach`；0.2.0-rc.2 能加载、侧栏标签可用，但终端采集会报错——该版本的接口还叫 `follow`）
- **不依赖 better-sidebar**——只用官方服务（`sidebarRight`、`remote.terminal`）
- 网页正文读取仅桌面端；Web 版（浏览器访问）可用侧栏标签 + 终端两条路

## 兼容性

| 宿主版本 | 加载 | 侧栏标签 | 终端 | 网页正文 |
|---|---|---|---|---|
| >= 0.2.1-rc.2 | ✅ | ✅ | ✅ | 桌面 ✅ / Web ❌ |
| 0.2.0-rc.2 | ✅ | ✅ | ❌（接口改名 follow→attach） | 桌面 ✅ / Web ❌ |

## 隐私与安全

- 只读当前会话的数据，跨会话内容不出浏览器；
- 全部数据只落本机：宿主路由挂在 loopback HTTP（`/sidebar-reader/*`）上，不过浏览器鉴权、不出机器；
- 每次读取都有 toast 提示，无静默采集；
- 无遥测、无外部请求。

## 宿主路由（前缀 `/sidebar-reader`）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/health` | GET | 自检：有无快照、有无待领命令 |
| `/latest` | GET | 模型读快照（无快照 404） |
| `/latest` | POST | 客户端交快照（整体替换，只留最新） |
| `/command` | GET | 客户端领命令（消费即清空，一条命令只执行一次） |
| `/command` | POST | 模型下发命令 |

## 许可

[MIT](LICENSE)
