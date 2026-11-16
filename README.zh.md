# dsh-sidebar-reader

[English](README.md) | 中文

让模型按需读取**当前会话**的侧边栏：当前选中的标签、官方右侧栏标签、终端屏幕、浏览器网页正文。

装好后对模型说一句「读一下我的侧边栏」或「看我开着的终端」，模型通过插件的命令通道触发一次采集，几秒内就能拿到快照。

## 工作原理

```
模型 ──POST /sidebar-reader/command──▶ 宿主路由 (lib/index.js)
                                          │ 客户端每 2s 轮询领命令
                                          ▼
                     客户端采集 (lib/client.js，跑在 Web UI 里)
                     ├── 当前选中标签（sidebarRight.active()，活动窗格的活动标签）
                     ├── 官方右侧栏标签（sidebarRight.openTabs，按当前会话过滤）
                     ├── 终端屏幕（remote.terminal.attach，取首个全屏快照 → 去 ANSI、
                     │    与上次读取比只留增量）
                     └── 网页正文（webview innerText，仅桌面端）
                                          │
                       客户端 ──POST /sidebar-reader/latest──▶ 宿主只保留最新一份
模型 ◀──GET /sidebar-reader/latest──── 宿主
```

## 模型工具（自动注册）

插件宿主侧会向 DSH 工具注册表注册一个原生 agent 工具 **`sidebar_read`**：每个新会话的工具清单里自动出现，模型一次调用即拿到全量快照，无需任何 HTTP 调用或配置。「读终端/网页先走侧边栏」的偏好直接编码在工具描述里。

唯一参数是 `delta`（缺省 `true`）：终端屏幕从第二次读取起只回增量。需要重新拿到每个终端的完整屏幕时传 `delta: false`。

下方 HTTP 端点保留为兜底通道。

## 功能

| 采集路 | 来源 | 说明 |
|---|---|---|
| 当前选中标签 | `sidebarRight.active()` | 活动窗格的活动标签（id / kind / title / contentId），并带 `expanded` 表示侧栏是否展开 |
| 右侧栏标签 | `sidebarRight.openTabs` 活快照 | 当前会话打开的全部标签（`tabId` / `kind` / `contentId`），**只取当前会话** |
| 终端屏幕 | `remote.terminal.attach` 首帧快照 | 含滚动缓冲的完整屏幕，去 ANSI 后按增量回传（见下）；读完立即断开归还输入权 |
| 网页正文 | 侧栏浏览器 webview 的 `innerText` | **仅桌面端（Electron）**；严格模式，见下 |

### 终端文本的三道处理

xterm 的原始屏幕并不适合直接喂模型：夹着大量颜色/光标转义、每次读取都把整屏滚动缓冲重复一遍、长度还可能很长。所以每块屏幕在 `lib/client.js` 里过三道：

| 处理 | 做什么 | 为什么 |
|---|---|---|
| `stripAnsi` | 去掉 ANSI/OSC 转义序列与不可见控制符 | 转义纯属 token 浪费，模型也读不懂 |
| `screenDelta` | 按终端 id 记住上次回传的屏幕，本次只回新增部分；界面重绘时退化为按行的公共前缀；完全对不上就整屏回传（不丢文本） | 连续读取只花原来零头的上下文 |
| `capScreen` | 只保留尾部，单终端上限 500 行 / 2 万字 | 滚动缓冲可能极长，最新输出在末尾 |

因此每个终端条目带三个字段：`screen`（干净文本）、`delta`（`false` = 这是完整屏幕，即该终端首次读取或显式要了全屏）、`truncated`（`true` = 触发了行/字符上限）。`delta:false` 同时会刷新增量基准，下一轮增量仍然对得上。

### 网页正文的「严格模式」

只有满足两条时才读网页：**当前选中的标签是 browser**，且**侧栏处于展开状态**。否则 `page` 一律为 `null`。

原因：侧栏把没选中的浏览器标签收进后台时，webview 仍留在 DOM 里（宽度为 0），兜底逻辑会把它当成「最后一个」读回来——模型就会拿到用户根本没在看的页面。宁可给 `null`，也不给错的那一页。

## 能读到什么

| 你在看的东西 | 能读到 | 说明 |
|---|---|---|
| 侧栏浏览器里的网页 | ✅ 标题 + URL + 正文 | 必须是当前选中的 browser 标签，且侧栏展开 |
| 侧栏里的文件/文档标签 | ⚠️ 只有地址 | 给的是 `contentId`（如 `dsh-resource://file/...`），正文要按路径另外读 |
| 终端 | ✅ 屏幕文本 | 去 ANSI；首次整屏，之后只回新增行（单终端上限 500 行 / 2 万字） |
| 纯 Web 版 DSH（浏览器访问） | ❌ 网页正文 | 没有 webview；标签与终端仍可读 |

## 快照示例

```json
{
  "page": { "title": "…", "url": "https://…", "text": "…", "chars": 1235 },
  "right": {
    "sessionId": "session-…",
    "expanded": true,
    "active": { "id": "tab5", "type": "browser", "title": "浏览器", "path": "sidebar://browser/…" },
    "tabs": [
      { "id": "tab3", "type": "files", "path": "sidebar://files" },
      { "id": "tab5", "type": "browser", "path": "sidebar://browser/…" }
    ]
  },
  "terminals": {
    "sessionId": "session-…",
    "terminals": [
      { "id": "…", "title": "…", "state": "running", "screen": "…", "delta": false, "truncated": false }
    ]
  },
  "commandId": "cmd-…",
  "receivedAt": "2026-11-08T13:11:42.350Z"
}
```

四条设计纪律：

1. **作用域**：所有数据先按「屏幕上的会话」过滤才出浏览器，别的会话读不到；
2. **永不抛错**：各采集路独立降级，一路坏了其余照常返回；
3. **透明**：每次读取界面都弹 toast，用户看得见；
4. **可撤销**：所有副作用挂在 `ctx.effect` 上，禁用插件即干净退场。

## 安装

```sh
# 插件市场（dshmarket 或官方发现页收录后）里搜索 Sidebar Reader
# 或命令行：
dsh plugin --profile <你的profile> add dsh-sidebar-reader
```

官方 DSH Desktop 桌面端请在应用自身的 **设置 → 插件** 里安装（或把本仓库克隆到任意目录，用插件管理的本地安装指向该目录）。

## 要求

- **DSH >= 0.2.1-rc.2**（终端读取依赖 `remote.terminal.attach`；0.2.0-rc.2 能加载、侧栏标签可用，但终端采集会报错——该版本的接口还叫 `follow`）
- **不依赖 better-sidebar**——只用官方服务（`sidebarRight`、`remote.terminal`）
- 网页正文读取仅桌面端；Web 版（浏览器访问）可用当前选中标签 + 标签列表 + 终端

## 兼容性

| 宿主版本 | 加载 | 选中标签 | 侧栏标签 | 终端 | 网页正文 |
|---|---|---|---|---|---|
| 0.2.1-rc.2 ~ 0.2.2-rc.3 | ✅ | ✅ | ✅ | ✅ | 桌面 ✅ / Web ❌ |
| 0.2.0-rc.2 | ✅ | ⚠️ | ✅ | ❌（接口改名 follow→attach） | 桌面 ✅ / Web ❌ |

实测说明：0.2.1-rc.5 与 0.2.2-rc.3（含终端增量读取）上四路全功能实测通过；0.2.1-rc.2 与 0.2.2-rc.1 完成了安装、组合与客户端模块注册验证（`scripts/test-plugin.ps1`）。

## 开发与测试

仓库自带两个脚本（Windows PowerShell）：

```powershell
# 1) 冒烟测试：对着已经跑起来的 GUI 端口，验证宿主+客户端+快照三件事
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-plugin.ps1 -Port 53233

# 2) 多版本兼容测试：每个版本独立目录 + 独立 DSH_HOME，不动你正在用的桌面端
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-plugin.ps1 -Version 0.2.1-rc.2 -Port 6123
```

```sh
# 3) 终端文本三道处理的单元测试（stripAnsi / capScreen / screenDelta）
node scripts/test-text-helpers.mjs
```

两个容易踩的坑：

- **改了客户端代码必须刷新页面**：宿主会立刻换掉 bundle（rev 变化），但页面里已加载的模块不会自己替换——HMR 的图同步只处理「新增/删除 entry」，不处理「已有 entry 替换」；
- **`lib/client.js` 里 `__ModuleLoader__.load({ id })` 的 id 必须等于 npm 包名**（含 scope）。DSH 的客户端模块系统按包名匹配注册，写错会静默加载失败——表现是 `sidebar_read` 能调、但每次 `capture timed out`。

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

## 更新日志

- **1.1.0** — 终端读取改为省上下文的形态：屏幕去 ANSI、首次之后只回增量（`delta`，可用 `delta:false` 要全屏）、单终端上限 500 行 / 2 万字；新增 `scripts/test-text-helpers.mjs`；在 DSH 0.2.2-rc.3 上端到端实测通过。
- **1.0.1** — 修复客户端模块注册 id 与包名不一致（此前任何宿主上客户端都不会加载，表现为 `capture timed out`）；`tabs[].id` 改用真实 `tabId`；新增 `right.active`（当前选中标签）与 `right.expanded`；网页正文改为严格模式（非 browser 标签或侧栏收起时返回 `null`）。
- **1.0.0** — 首个版本。

## 许可

[MIT](LICENSE)
