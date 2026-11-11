# dsh-terminal-operator

让模型**操作**侧边栏终端，而不只是读它。

## 能力

| 工具 | 作用 |
|---|---|
| `terminal_list` | 列出当前会话保留的终端（id / 标题 / 状态 / cwd / shell） |
| `terminal_write` | 向指定终端键入文本，等落屏后返回屏幕尾部 |
| `terminal_open` | 新建一个 agent 专用终端，返回 terminalId |
| `terminal_close` | 关闭终端，杀进程并释放名额 |

## 实现要点

- **宿主 = 信箱**：`lib/index.js` 在 loopback `webServer` 注册 `/terminal-operator/{command,result,health}`，不经过浏览器鉴权；四个 agent 工具通过 `pendingCommand` / `results` 与客户端配对。
- **客户端 = 真正的键盘**：`lib/client.js` 每 1.5s 轮询领命令，用 `ctx.remote.terminal.attach()` 拿到双工流，`handle.send({type:"write",sequence,data})` 写入，等 `ack` 并消费输出帧，最后 `abort()` 释放输入权。
- **为什么必须过桥**：`remote.terminal` 是 cordis 注入的渲染进程服务，宿主进程拿不到。

## 协议要点（照官方 terminal-controller）

- `sequence` 从 1 连续递增；`ack` 必须按序到达，否则 `invalidOutput`。
- 必须持续消费帧：过慢订阅者会被判失败。
- 最新 attach 持有输入权；`abort` 只释放输入权，**不结束进程**。
- 单条写入上限 `maxInputBytes`（默认 64KB），本插件内部再 cap 到 4000 字符。

## 已知行为

- `terminal_write` **执行前必须用户确认**：客户端弹窗显示模型要键入的原文，默认焦点在「拒绝」，Esc 取消，120 秒未处理自动拒绝；拒绝时工具返回 `{rejected:true}`。
- 每次请求 / 结果 / 拒绝都会追加到 `~/.dsh/terminal-operator-audit.log`（NDJSON，一行一条）。
- `terminal_open` 默认通过 `sidebarRight.openTab('terminal')` **开一个可见标签页**；传 `showInSidebar:false` 才退回无头终端——注意 Host 上「保存布局之外」的终端没有 UI 恢复入口，用户看不到。
- `terminal_write` 期间会**短暂接管**该终端的键盘输入；断开后 GUI 可能需要你点一下「接管输入」才能继续打字。
- 页面隐藏（最小化）时客户端不轮询命令，工具会超时报错。
- 只适合行式命令；`vim` / `top` 这类全屏 TUI 不适用。
- 用户终端以系统用户权限运行，**独立于 agent 沙箱与审批策略**——这是一条实质的权限边界变化，调用前请确认用户意图。

## 本地安装

```powershell
# 1. 复制到 profile 的 vendor 与 node_modules
Copy-Item -Recurse <本目录> "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-terminal-operator" -Force
Copy-Item -Recurse <本目录> "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-terminal-operator" -Force

# 2. profile/package.json 里加依赖与 bundle 条目
#    "dsh-terminal-operator": "file:vendor/dsh-terminal-operator"
#    dsh.profile.bundles 追加 "dsh-terminal-operator"

# 3. 重启 DSH 应用（宿主 bundle 在启动时加载）
```
