// ============================================================================
// dsh-terminal-operator · 客户端部分（运行在 GUI 渲染进程页面里）
//
// 架构（与 lib/index.js 宿主路由配合）：
//
//   模型 ──POST 工具──> 宿主 pendingCommand ──客户端 1.5s 轮询 /command──> 本文件
//                              ▲                                            │ 执行
//   模型 <──工具轮询结果── 宿主 results ←──POST /terminal-operator/result──────┘
//
// 为什么写入必须在这里：`remote.terminal` 是 cordis 注入的渲染进程服务
// （@deepseek-ai/dsh-api-terminal-controller）。宿主进程拿不到 ctx.remote。
//
// 写入协议（官方 attach 双工流）：
//   入向：{type:"snapshot", screen, inputWindow:{maxBytes,frameOverheadBytes}, writable}
//         {type:"output", sequence, data}
//         {type:"ack", sequence}
//   出向：handle.send({type:"write", sequence, data})
//
// 三条硬规则：sequence 必须从 1 连续递增；每条等 ack；消费帧不能停（过慢订阅者会被踢）。
// 最新 attach 持有输入权，abort 只释放输入权、不结束进程。
// ============================================================================

window.__ModuleLoader__.load({
	id: "dsh-terminal-operator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region 注入与常量
		// cordis 注入清单（硬性）：sidebarRight 用来定位当前会话；remote.terminal 是终端命名空间。
		const inject = ["sidebarRight", "remote", "remote.terminal"];
		const COMMAND_POLL_MS = 1500;
		const SCREEN_TAIL_CHARS = 20000;
		//#endregion

		//#region 基础工具
		/** 相对路径 → 绝对 URL（基于 GUI 页面自身 origin）。 */
		function base(url) {
			return new URL(url, document.baseURI).href;
		}

		/** 当前会话 id：sidebarRight.mounted 是「屏幕上会话」的可观察快照。 */
		function currentSessionId(ctx) {
			const mounted = ctx.sidebarRight?.mounted?.getSnapshot?.();
			return typeof mounted === "string" && mounted.length > 0 ? mounted : null;
		}

		/**
		 * 帧形状归一：官方可能给裸帧，也可能包一层 {value:帧}。
		 * 两种都兼容，拿不到 type 就原样返回。
		 */
		function unwrapFrame(raw) {
			if (raw !== null && typeof raw === "object" && raw.value !== null && typeof raw.value === "object" && "type" in raw.value) {
				return raw.value;
			}
			return raw;
		}

		/** 随机 id（terminal/create 要求调用方提供幂等身份）。 */
		function newTerminalId() {
			const c = globalThis.crypto;
			if (c && typeof c.randomUUID === "function") return c.randomUUID();
			return "term-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
		}

		function tail(text, limit) {
			const value = typeof text === "string" ? text : "";
			return value.length > limit ? "…" + value.slice(value.length - limit) : value;
		}

		/** 屏幕中下方的临时提示条（2.6s 淡出）：每次写终端用户都看得见。 */
		function toast(message, ok) {
			const node = document.createElement("div");
			node.textContent = message;
			for (const [key, value] of Object.entries({
				position: "fixed",
				left: "50%",
				bottom: "72px",
				transform: "translateX(-50%)",
				zIndex: "2147483646",
				maxWidth: "60vw",
				padding: "7px 14px",
				borderRadius: "8px",
				font: "12px/1.5 system-ui, sans-serif",
				color: ok ? "#0f0" : "#ffd7a0",
				background: ok ? "rgba(20,60,30,.92)" : "rgba(70,40,10,.92)",
				border: "1px solid rgba(255,255,255,.18)",
				boxShadow: "0 4px 18px rgba(0,0,0,.35)",
				pointerEvents: "none",
				transition: "opacity .35s ease"
			})) node.style[key] = value;
			document.body.append(node);
			setTimeout(() => {
				node.style.opacity = "0";
				setTimeout(() => node.remove(), 400);
			}, 2600);
		}
		//#endregion

		//#region 传输
		/** 领命令；无命令 / 非法响应一律返回 null（安静空转）。 */
		async function fetchCommand() {
			const response = await fetch(base("terminal-operator/command"), { cache: "no-store" });
			if (!response.ok) return null;
			return await response.json().catch(() => null);
		}

		/** 交结果给宿主；失败抛错（由轮询 try/catch 兜住）。 */
		async function sendResult(payload) {
			const response = await fetch(base("terminal-operator/result"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			return await response.json().catch(() => ({}));
		}
		//#endregion

		//#region 终端操作
		/** 取终端命名空间；缺失直接报错，避免半截执行。 */
		function terminalRemote(ctx) {
			const remote = ctx.remote?.terminal;
			if (remote === undefined || typeof remote.list !== "function" || typeof remote.attach !== "function") {
				throw new Error("terminal remote namespace unavailable");
			}
			return remote;
		}

		/** 列出当前会话保留的终端。 */
		async function listTerminals(ctx) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === null) throw new Error("no session is on screen");
			const remote = terminalRemote(ctx);
			const listed = await remote.list(sessionId);
			if (listed === null || listed === void 0 || listed.ok !== true || !Array.isArray(listed.value)) {
				throw new Error("terminal list failed: " + (listed?.error?.message ?? "unknown"));
			}
			return {
				sessionId,
				terminals: listed.value.map((info) => ({
					id: info.id,
					title: info.title ?? null,
					state: info.state ?? null,
					cwd: info.cwd ?? null,
					shell: info.shell?.name ?? info.shell?.path ?? null
				}))
			};
		}

		/**
		 * 向已有终端键入文本，返回落屏后的屏幕尾部。
		 *
		 * 关键点：
		 *   - attach 后**第一帧必须是 snapshot**，从它拿 inputWindow 与基线屏幕；
		 *   - 写入后必须持续消费 output/ack 帧，否则被判「过慢订阅者」踢掉；
		 *   - 靠「已 ack + 输出静默 settleMs」判定命令跑完；硬超时兜底；
		 *   - finally 里 abort：只释放输入权，终端进程与屏幕都保留。
		 */
		async function writeTerminal(ctx, args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === null) throw new Error("no session is on screen");
			const remote = terminalRemote(ctx);

			const terminalId = typeof args.terminalId === "string" ? args.terminalId : "";
			if (terminalId.length === 0) throw new Error("terminalId is required");
			let text = typeof args.text === "string" ? args.text : "";
			if (text.length === 0) throw new Error("text is required");
			// cap 到 4000 字符：底层单命令 64KB，留足 JSON 转义余量。
			if (text.length > 4000) text = text.slice(0, 4000);
			const submit = args.submit !== false;
			if (submit && !text.endsWith("\r")) text += "\r";

			const settleMs = Number.isFinite(args.settleMs) ? Math.max(120, Math.min(8000, args.settleMs)) : 900;
			const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(1500, Math.min(60000, args.timeoutMs)) : 15000;

			const controller = new AbortController();
			const state = {
				screen: "",
				sequence: 0,
				acknowledged: 0,
				sent: false,
				refused: false,
				lastActivity: Date.now(),
				reason: "timeout"
			};

			// 静默看门狗：没有新帧时 for-await 会一直挂着，靠它判定「输出已停」并断开。
			const idleTimer = setInterval(() => {
				if (state.sent && state.acknowledged >= state.sequence && Date.now() - state.lastActivity >= settleMs) {
					state.reason = "settled";
					controller.abort();
				}
			}, 60);
			const hardTimer = setTimeout(() => {
				state.reason = "timeout";
				controller.abort();
			}, timeoutMs);

			let handle = null;
			try {
				handle = remote.attach(sessionId, terminalId, controller.signal);
				for await (const raw of handle) {
					const frame = unwrapFrame(raw);
					if (frame === null || typeof frame !== "object") continue;
					state.lastActivity = Date.now();

					if (frame.type === "snapshot") {
						state.screen = typeof frame.screen === "string" ? frame.screen : "";
						// writable === false 表示这条附件拿不到输入权：不发写帧，直接交回原因。
						if (frame.writable === false) {
							state.refused = true;
						} else if (!state.sent) {
							state.sequence += 1;
							handle.send({ type: "write", sequence: state.sequence, data: text });
							state.sent = true;
						}
					} else if (frame.type === "output") {
						state.screen += typeof frame.data === "string" ? frame.data : "";
					} else if (frame.type === "ack") {
						// 控制权被拒绝时会带上错误标记：停止再写，把原因交回模型。
						if (frame.error !== undefined || frame.ok === false) state.refused = true;
						else state.acknowledged = frame.sequence;
					}

					if (state.sent && state.refused) {
						state.reason = "refused";
						break;
					}
					if (state.sent && state.acknowledged >= state.sequence && Date.now() - state.lastActivity >= settleMs) {
						state.reason = "settled";
						break;
					}
				}
			} catch (error) {
				// abort 引发的异常是正常收尾路径，不是失败。
				if (!controller.signal.aborted) throw error;
			} finally {
				clearInterval(idleTimer);
				clearTimeout(hardTimer);
				try { controller.abort(); } catch { /* 已断开 */ }
				try { handle?.return?.(); } catch { /* 迭代器已结束 */ }
			}

			if (state.refused) {
				throw new Error("terminal refused input (input control was taken by another view, or the process exited)");
			}
			if (state.sequence > 0 && state.acknowledged < state.sequence && state.reason === "timeout") {
				throw new Error("terminal did not acknowledge the write within " + String(timeoutMs) + "ms");
			}

			return {
				terminalId,
				reason: state.reason,
				acked: state.acknowledged,
				sentChars: text.length,
				screen: tail(state.screen, SCREEN_TAIL_CHARS)
			};
		}

		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		/** 取当前会话的终端 id 集合，用于「开标签前后对比」。 */
		async function listIds(remote, sessionId) {
			const listed = await remote.list(sessionId);
			const ids = new Set();
			if (listed !== null && listed !== void 0 && listed.ok === true && Array.isArray(listed.value)) {
				for (const info of listed.value) ids.add(info.id);
			}
			return ids;
		}

		/**
		 * 新建终端，并尽量让它以**标签页**出现在侧栏。
		 *
		 * 为什么不是 remote.create：Host 上「保存布局之外」的终端没有任何 UI 恢复入口
		 * （官方 sidebar-terminal 文档明确写了这一点），create 出来的终端用户永远看不见。
		 * 正确做法是调用 sidebarRight.openTab('terminal') 让侧栏自己分配标签与终端，
		 * 再对比前后列表把新终端 id 抓出来交给模型。
		 */
		async function openTerminal(ctx, args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === null) throw new Error("no session is on screen");
			const remote = terminalRemote(ctx);

			const sidebar = ctx.sidebarRight;
			const canOpenTab = typeof sidebar?.openTab === "function";
			const wantsTab = args.showInSidebar !== false;

			if (wantsTab && canOpenTab) {
				const before = await listIds(remote, sessionId);
				try {
					sidebar.openTab("terminal");
				} catch (error) {
					// 开标签失败就退回无头终端，不要把整个调用变成错误。
					console.warn("[terminal-operator] openTab failed, falling back to create", error);
				}
				const deadline = Date.now() + 8000;
				while (Date.now() < deadline) {
					await sleep(200);
					const listed = await remote.list(sessionId);
					if (listed !== null && listed !== void 0 && listed.ok === true && Array.isArray(listed.value)) {
						const fresh = listed.value.find((info) => info.id !== undefined && !before.has(info.id));
						if (fresh !== undefined) {
							return {
								terminalId: fresh.id,
								title: fresh.title ?? null,
								state: fresh.state ?? null,
								cwd: fresh.cwd ?? null,
								shell: fresh.shell?.name ?? null,
								shownInSidebar: true,
								note: "opened as a sidebar terminal tab; the tab is now visible"
							};
						}
					}
				}
			}

			// 兜底：无头终端（侧栏不可用或调用方明确不要标签）。
			if (typeof remote.create !== "function") throw new Error("terminal create unavailable");
			const cols = Number.isFinite(args.cols) ? Math.max(20, Math.min(500, Math.round(args.cols))) : 120;
			const rows = Number.isFinite(args.rows) ? Math.max(5, Math.min(200, Math.round(args.rows))) : 30;
			const created = await remote.create(sessionId, { id: newTerminalId(), cols, rows });
			if (created === null || created === void 0 || created.ok !== true) {
				throw new Error("terminal create failed: " + (created?.error?.message ?? "unknown"));
			}
			const info = created.value;
			return {
				terminalId: info.id,
				title: info.title ?? null,
				state: info.state ?? null,
				cwd: info.cwd ?? null,
				shell: info.shell?.name ?? null,
				shownInSidebar: false,
				note: "headless terminal: no sidebar tab, so the user cannot see it"
			};
		}

		/** 关闭终端：杀进程并释放名额；重复关闭成功。 */
		async function closeTerminal(ctx, args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === null) throw new Error("no session is on screen");
			const remote = terminalRemote(ctx);
			const terminalId = typeof args.terminalId === "string" ? args.terminalId : "";
			if (terminalId.length === 0) throw new Error("terminalId is required");
			const closed = await remote.close(sessionId, terminalId);
			if (closed !== null && closed !== void 0 && closed.ok === false) {
				throw new Error("terminal close failed: " + (closed.error?.message ?? "unknown"));
			}
			return { terminalId, closed: true };
		}
		//#endregion

		//#region 执行前确认
		/** 用户拒绝执行的标记错误：客户端回传 rejected，宿主据此返回"被拒绝"而不是失败。 */
		class UserRejected extends Error {
			constructor() {
				super("user declined to run the command");
				this.rejected = true;
			}
		}

		/** 确认弹窗的自动拒绝时长（毫秒）；要小于工具侧 180s 超时。 */
		const CONFIRM_TIMEOUT_MS = 120000;

		/**
		 * 在页面上弹出确认框，显示模型要键入的原文，等用户点「执行」或「拒绝」。
		 * 安全语义：默认焦点在「拒绝」，Esc 取消，超时自动拒绝，点遮罩也拒绝。
		 * @returns {Promise<boolean>} true=允许执行，false=拒绝
		 */
		function confirmCommand(command) {
			return new Promise((resolve) => {
				const args = command.args !== null && typeof command.args === "object" ? command.args : {};
				const text = typeof args.text === "string" ? args.text : "";
				const terminalId = typeof args.terminalId === "string" ? args.terminalId : "";

				const overlay = document.createElement("div");
				overlay.setAttribute("role", "dialog");
				overlay.setAttribute("aria-modal", "true");
				Object.assign(overlay.style, {
					position: "fixed", inset: "0", zIndex: "2147483647",
					background: "rgba(0,0,0,.45)", display: "flex",
					alignItems: "center", justifyContent: "center",
					font: "13px/1.6 system-ui, sans-serif", color: "#eee"
				});

				const panel = document.createElement("div");
				Object.assign(panel.style, {
					width: "min(560px, 92vw)", background: "#1e1f22",
					border: "1px solid rgba(255,255,255,.14)", borderRadius: "12px",
					boxShadow: "0 20px 60px rgba(0,0,0,.5)", padding: "18px 20px"
				});

				const title = document.createElement("div");
				title.textContent = "模型请求向终端输入命令";
				Object.assign(title.style, { fontSize: "14px", fontWeight: "600", marginBottom: "8px" });

				const meta = document.createElement("div");
				meta.textContent = "目标终端：" + (terminalId || "未知");
				Object.assign(meta.style, { fontSize: "12px", color: "#9aa0a6", marginBottom: "10px", wordBreak: "break-all" });

				const pre = document.createElement("pre");
				pre.textContent = text;
				Object.assign(pre.style, {
					margin: "0 0 12px", padding: "10px 12px", borderRadius: "8px",
					background: "#111214", border: "1px solid rgba(255,255,255,.08)",
					font: "12px/1.55 ui-monospace, Consolas, monospace",
					whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "220px", overflow: "auto"
				});

				const hint = document.createElement("div");
				Object.assign(hint.style, { fontSize: "12px", color: "#9aa0a6", marginBottom: "14px" });

				const buttons = document.createElement("div");
				Object.assign(buttons.style, { display: "flex", justifyContent: "flex-end", gap: "10px" });

				const reject = document.createElement("button");
				reject.type = "button";
				reject.textContent = "拒绝";
				Object.assign(reject.style, {
					padding: "7px 16px", borderRadius: "8px", cursor: "pointer",
					border: "1px solid rgba(255,255,255,.2)", background: "transparent", color: "#eee",
					font: "13px system-ui, sans-serif"
				});

				const approve = document.createElement("button");
				approve.type = "button";
				approve.textContent = "执行";
				Object.assign(approve.style, {
					padding: "7px 16px", borderRadius: "8px", cursor: "pointer",
					border: "1px solid rgba(90,190,120,.5)", background: "#22502f", color: "#dff5e3",
					font: "13px system-ui, sans-serif"
				});

				buttons.append(reject, approve);
				panel.append(title, meta, pre, hint, buttons);
				overlay.append(panel);

				let done = false;
				let deadline = Date.now() + CONFIRM_TIMEOUT_MS;
				const ticker = setInterval(() => {
					const left = Math.max(0, deadline - Date.now());
					hint.textContent = "剩余 " + String(Math.ceil(left / 1000)) + " 秒自动拒绝 · Esc 取消 · 回车确认当前按钮";
					if (left <= 0) finish(false);
				}, 1000);
				hint.textContent = "剩余 " + String(Math.ceil(CONFIRM_TIMEOUT_MS / 1000)) + " 秒自动拒绝 · Esc 取消 · 回车确认当前按钮";

				function onKey(event) {
					if (event.key === "Escape") {
						event.preventDefault();
						finish(false);
					}
				}

				function finish(value) {
					if (done) return;
					done = true;
					clearInterval(ticker);
					window.removeEventListener("keydown", onKey, true);
					overlay.remove();
					resolve(value);
				}

				reject.addEventListener("click", () => finish(false));
				approve.addEventListener("click", () => finish(true));
				overlay.addEventListener("click", (event) => {
					if (event.target === overlay) finish(false);
				});
				window.addEventListener("keydown", onKey, true);

				document.body.append(overlay);
				// 默认焦点在「拒绝」：误按回车不会执行命令。
				reject.focus();
				// 允许用户临时放弃等待
				void deadline;
			});
		}
		//#endregion

		//#region 命令分发
		/** 按 action 分发；未知 action 明确报错而不是静默。 */
		async function runCommand(ctx, command) {
			const args = command.args !== null && typeof command.args === "object" ? command.args : {};
			switch (command.action) {
				case "terminal-list": return await listTerminals(ctx);
				case "terminal-write": {
					// 执行前确认：模型不能绕过，只有用户点「执行」才真正发写帧。
					if (command.needsConfirm === true) {
						const approved = await confirmCommand(command);
						if (!approved) throw new UserRejected();
					}
					return await writeTerminal(ctx, args);
				}
				case "terminal-open": return await openTerminal(ctx, args);
				case "terminal-close": return await closeTerminal(ctx, args);
				default: throw new Error("unknown action: " + String(command.action));
			}
		}

		/** 命令轮询主循环：领命令 → 执行 → 回结果。页面隐藏时跳过。 */
		function startCommandPoll(ctx) {
			let inFlight = false;
			const timer = setInterval(async () => {
				if (inFlight || document.visibilityState === "hidden") return;
				inFlight = true;
				let command = null;
				try {
					command = await fetchCommand();
					if (command === null || command === void 0 || command.id === null || command.id === void 0) return;
					const data = await runCommand(ctx, command);
					await sendResult({ commandId: command.id, action: command.action, ok: true, data });
					if (command.action === "terminal-write") {
						toast("模型向终端写入了命令", true);
					} else if (command.action === "terminal-open") {
						toast("模型新建了一个终端", true);
					} else if (command.action === "terminal-close") {
						toast("模型关闭了一个终端", true);
					}
				} catch (error) {
					const message = String(error && error.message ? error.message : error);
					console.warn("[terminal-operator] command failed", error);
					const rejected = error !== null && typeof error === "object" && error.rejected === true;
					if (command !== null && command !== void 0 && typeof command.id === "string") {
						await sendResult({
							commandId: command.id,
							action: command.action,
							ok: false,
							rejected,
							error: message
						}).catch(() => {});
					}
					toast(rejected ? "你拒绝了模型的终端命令" : "终端操作失败：" + message, rejected);
				} finally {
					inFlight = false;
				}
			}, COMMAND_POLL_MS);
			return () => clearInterval(timer);
		}
		//#endregion

		//#region 入口
		/** cordis 入口：挂载轮询；清理函数随 effect 撤销。 */
		function apply(ctx) {
			ctx.effect(() => startCommandPoll(ctx), "ui-terminal-operator: model command poll");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
