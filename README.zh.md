# dsh-sidebar-operator

读取侧边栏，并且**操作**它的终端。

本插件是 `dsh-sidebar-reader` 的整合版：读取能力保留，新增终端写入/新建/关闭。

## 五个工具

| 工具 | 作用 |
|---|---|
| `sidebar_read` | 读当前会话侧栏：标签页、每个终端的屏幕、侧栏浏览器网页正文 |
| `terminal_list` | 列出会话保留的终端（id / 标题 / 状态 / cwd / shell） |
| `terminal_write` | 向指定终端键入文本，等落屏后返回屏幕尾部 |
| `terminal_open` | 新建终端，默认开成可见标签页 |
| `terminal_close` | 关闭终端，结束其进程树 |

## 写入的闸门

没有命令白名单。用**会话的沙箱策略**判断：

```
sandboxPolicy.resolve({session})
  mode === danger-full-access            → 直接执行
  命令头命中破坏性集合（format/reg/…）    → 审批
  命令里的路径全部在 workspaceRoot 内     → 直接执行
  出现越界路径                            → 审批
```

审批走宿主原生 `ctx.approval.request()`（底部审批 UI），不是自绘弹窗；只有拿不到审批服务时才退回自绘框。

- 会话策略 `never`（Full access 预设）时跳过审批——否则 `request()` 会确定性返回 `rejected`，插件直接不可用。
- 每次请求 / 审批 / 执行都会写 `~/.dsh/sidebar-operator-audit.log`（NDJSON）。

## 协议要点

- 写入走官方 `remote.terminal.attach` 双工流：`handle.send({type:"write",sequence,data})`，`sequence` 从 1 连续递增，必须持续消费输出帧并等 `ack`。
- 最新 attach 持有输入权；`abort` 只释放输入权，**不结束进程**。
- 单条写入上限 4000 字符（底层 `maxInputBytes` 默认 64KB）。
- `terminal_open` 用 `sidebarRight.openTab('terminal')` 开真标签——Host 上「布局之外」的终端没有任何 UI 恢复入口。

## 已知行为

- 写入期间短暂接管该终端键盘；断开后 GUI 可能需要你点「接管输入」。
- 页面隐藏时客户端不轮询，工具会超时。
- 路径判定是启发式（不解析 shell 变量展开），终端本身不在沙箱内。
- `terminal_close` 永远需要审批。

## 安装

把本目录放到 `~/.dsh/profiles/desktop/vendor/dsh-sidebar-operator` 与
`node_modules/dsh-sidebar-operator`，在 profile 的 `dependencies` 写
`"dsh-sidebar-operator": "file:vendor/dsh-sidebar-operator"`，并把包名加进
`dsh.profile.bundles`，然后重启 DSH。
