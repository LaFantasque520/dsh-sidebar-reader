// ============================================================================
// dsh-sidebar-operator · 客户端部分（GUI 渲染进程）
//
// 两类命令：
//   capture          → 抓侧栏快照（网页正文 + 标签 + 终端屏幕），POST /latest
//   terminal-*       → 操作终端（list/open/write/close），POST /result
//
// 架构：
//   模型 ──工具──> 宿主 pendingCommand ──客户端 1.5s 轮询领走──> 本文件
//   模型 <──工具轮询 results / latest <──POST /result 或 /latest────────┘
//
// 写入协议（官方 attach 双工流）：
//   出向 handle.send({type:"write", sequence, data})，入向 snapshot/output/ack。
//   sequence 必须从 1 连续递增；必须持续消费帧；abort 只释放输入权。
// ============================================================================

window.__ModuleLoader__.load({
	id: "dsh-sidebar-operator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region 注入与常量
		const inject = ["sidebarRight", "remote", "remote.terminal"];
		const COMMAND_POLL_MS = 1500;
		const MAX_TEXT_CHARS = 200000;
		const SCREEN_TAIL_CHARS = 20000;
		const READ_SCRIPT =
			"(() => ({ title: document.title, url: location.href, text: ((document.body ? document.body.innerText " +
			": document.documentElement.innerText) || '').slice(0, " + String(MAX_TEXT_CHARS) + "), ready: document.readyState }))()";
		//#endregion

		//#region 基础
		function base(url) {
			return new URL(url, document.baseURI).href;
		}

		function currentSessionId(ctx) {
			const mounted = ctx.sidebarRight?.mounted?.getSnapshot?.();
			return typeof mounted === "string" && mounted.length > 0 ? mounted : null;
		}

		function unwrapFrame(raw) {
			if (raw !== null && typeof raw === "object" && raw.value !== null && typeof raw.value === "object" && "type" in raw.value) {
				return raw.value;
			}
			return raw;
		}

		function newTerminalId() {
			const c = globalThis.crypto;
			if (c && typeof c.randomUUID === "function") return c.randomUUID();
			return "term-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
		}

		function tail(text, limit) {
			const value = typeof text === "string" ? text : "";
			return value.length > limit ? "…" + value.slice(value.length - limit) : value;
		}

		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		/** 屏幕中下方的临时提示条，每次采集/写入用户都看得见。 */
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
		async function fetchCommand() {
			const response = await fetch(base("sidebar-operator/command"), { cache: "no-store" });
			if (!response.ok) return null;
			return await response.json().catch(() => null);
		}

		async function sendSnapshot(payload) {
			const response = await fetch(base("sidebar-operator/latest"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			return await response.json().catch(() => ({}));
		}

		async function sendResult(payload) {
			const response = await fetch(base("sidebar-operator/result"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			return await response.json().catch(() => ({}));
		}
		//#endregion

		//#region 读取（sidebar_read）
		function findSidebarWebview() {
			const candidates = [...document.querySelectorAll('webview[data-sidebar-browser-frame="webview"]')];
			return candidates.find((element) => element.clientWidth > 0 && element.clientHeight > 0) ?? candidates.at(-1) ?? null;
		}

		async function readSidebarPage() {
			const element = findSidebarWebview();
			if (element === null) return null;
			if (typeof element.executeJavaScript !== "function") return null;
			try {
				return await element.executeJavaScript(READ_SCRIPT, false);
			} catch {
				return null;
			}
		}

		/** 当前会话打开的官方侧栏标签 + 当前选中项。 */
		function rightSidebarState(ctx) {
			try {
				const sessionId = currentSessionId(ctx);
				if (sessionId === null) return { error: "no session is on screen" };
				const all = ctx.sidebarRight.openTabs.getSnapshot();
				const tabs = (Array.isArray(all) ? all : [])
					.filter((tab) => tab !== null && typeof tab === "object" && tab.sessionId === sessionId)
					.map((tab) => ({
						id: typeof tab.tabId === "string" ? tab.tabId : null,
						type: typeof tab.kind === "string" ? tab.kind : null,
						path: typeof tab.contentId === "string" ? tab.contentId : (typeof tab.address === "string" ? tab.address : null)
					}));
				let active = null;
				try {
					const record = typeof ctx.sidebarRight.active === "function" ? ctx.sidebarRight.active() : void 0;
					if (record !== null && record !== void 0 && typeof record === "object") {
						active = {
							id: typeof record.id === "string" ? record.id : null,
							type: typeof record.kind === "string" ? record.kind : null,
							title: typeof record.title === "string" ? record.title : null,
							path: typeof record.contentId === "string" ? record.contentId : null
						};
					}
				} catch {
					active = null;
				}
				let expanded = null;
				try {
					expanded = typeof ctx.sidebarRight.isExpanded === "function" ? ctx.sidebarRight.isExpanded() : null;
				} catch {
					expanded = null;
				}
				return { sessionId, expanded, active, tabs };
			} catch (error) {
				return { error: String(error && error.message ? error.message : error) };
			}
		}

		/** 只读窥探本会话每个终端：attach 拿首帧 snapshot 即断开（归还输入权）。 */
		async function terminalScreens(ctx) {
			try {
				const sessionId = currentSessionId(ctx);
				if (sessionId === null) return { error: "no session is on screen" };
				const remote = ctx.remote?.terminal;
				if (remote === undefined || typeof remote.list !== "function" || typeof remote.attach !== "function") {
					return { sessionId, error: "terminal remote namespace unavailable" };
				}
				const listed = await remote.list(sessionId);
				if (listed === null || listed === void 0 || listed.ok !== true || !Array.isArray(listed.value)) {
					return { sessionId, error: "terminal list failed" };
				}
				const terminals = [];
				for (const info of listed.value) {
					if (info === null || typeof info !== "object" || typeof info.id !== "string") continue;
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 4000);
					try {
						for await (const frame of remote.attach(sessionId, info.id, controller.signal)) {
							const unwrapped = unwrapFrame(frame);
							if (unwrapped !== null && typeof unwrapped === "object" && unwrapped.type === "snapshot") {
								terminals.push({
									id: info.id,
									title: typeof info.title === "string" ? info.title : null,
									state: typeof info.state === "string" ? info.state : null,
									screen: typeof unwrapped.screen === "string" ? unwrapped.screen.slice(0, 40000) : null
								});
								break;
							}
						}
					} catch (error) {
						terminals.push({
							id: info.id,
							title: typeof info.title === "string" ? info.title : null,
							error: String(error && error.message ? error.message : error)
						});
					} finally {
						clearTimeout(timer);
						controller.abort();
					}
				}
				return { sessionId, terminals };
			} catch (error) {
				return { error: String(error && error.message ? error.message : error) };
			}
		}

		/** 采集编排：网页正文（严格模式）+ 侧栏标签 + 终端屏幕。 */
		async function capture(ctx, commandId) {
			const right = rightSidebarState(ctx);
			const activeType = right !== null && typeof right === "object" && right.active !== null && typeof right.active === "object"
				? right.active.type
				: null;
			const collapsed = right !== null && typeof right === "object" && right.expanded === false;
			const page = !collapsed && activeType === "browser" ? await readSidebarPage() : null;
			const payload = {
				page: page === null ? null : { title: page.title, url: page.url, text: page.text },
				right,
				terminals: await terminalScreens(ctx),
				commandId: commandId ?? null
			};
			const receipt = await sendSnapshot(payload);
			return { payload, receipt };
		}
		//#endregion

		//#region 终端操作
		function terminalRemote(ctx) {
			const remote = ctx.remote?.terminal;
			if (remote === undefined || typeof remote.list !== "function" || typeof remote.attach !== "function") {
				throw new Error("terminal remote namespace unavailable");
			}
			return remote;
		}

		async function listIds(remote, sessionId) {
			const listed = await remote.list(sessionId);
			const ids = new Set();
			if (listed !== null && listed !== void 0 && listed.ok === true && Array.isArray(listed.value)) {
				for (const info of listed.value) ids.add(info.id);
			}
			return ids;
		}

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
		 * 关键：第一帧 snapshot 拿基线并发送写帧；持续消费帧否则被判过慢；
		 * 以「已 ack + 输出静默 settleMs」判定完成；finally abort 只释放输入权。
		 */
		async function writeTerminal(ctx, args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === null) throw new Error("no session is on screen");
			const remote = terminalRemote(ctx);

			const terminalId = typeof args.terminalId === "string" ? args.terminalId : "";
			if (terminalId.length === 0) throw new Error("terminalId is required");
			let text = typeof args.text === "string" ? args.text : "";
			if (text.length === 0) throw new Error("text is required");
			if (text.length > 4000) text = text.slice(0, 4000);
			const submit = args.submit !== false;
			if (submit && !text.endsWith("\r")) text += "\r";

			const settleMs = Number.isFinite(args.settleMs) ? Math.max(120, Math.min(8000, args.settleMs)) : 900;
			const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(1500, Math.min(60000, args.timeoutMs)) : 15000;

			const controller = new AbortController();
			const state = { screen: "", sequence: 0, acknowledged: 0, sent: false, refused: false, lastActivity: Date.now(), reason: "timeout" };

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

		/** 新建终端：优先开可见标签页；Host 上布局外的终端没有 UI 入口。 */
		async function openTerminal(ctx, args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === null) throw new Error("no session is on screen");
			const remote = terminalRemote(ctx);

			const sidebar = ctx.sidebarRight;
			const wantsTab = args.showInSidebar !== false;
			if (wantsTab && typeof sidebar?.openTab === "function") {
				const before = await listIds(remote, sessionId);
				try {
					sidebar.openTab("terminal");
				} catch (error) {
					console.warn("[sidebar-operator] openTab failed, falling back to create", error);
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

		//#region 回退确认弹窗（仅当宿主拿不到 approval 服务时使用）
		class UserRejected extends Error {
			constructor() {
				super("user declined to run the command");
				this.rejected = true;
			}
		}

		const CONFIRM_TIMEOUT_MS = 120000;

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
				const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
				const ticker = setInterval(() => {
					const left = Math.max(0, deadline - Date.now());
					hint.textContent = "剩余 " + String(Math.ceil(left / 1000)) + " 秒自动拒绝 · Esc 取消";
					if (left <= 0) finish(false);
				}, 1000);
				hint.textContent = "剩余 " + String(Math.ceil(CONFIRM_TIMEOUT_MS / 1000)) + " 秒自动拒绝 · Esc 取消";

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
				reject.focus();
			});
		}
		//#endregion

		//#region 命令分发与轮询
		async function runTerminalCommand(ctx, command) {
			const args = command.args !== null && typeof command.args === "object" ? command.args : {};
			switch (command.action) {
				case "terminal-list": return await listTerminals(ctx);
				case "terminal-write": {
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

		function startCommandPoll(ctx) {
			let inFlight = false;
			const timer = setInterval(async () => {
				if (inFlight || document.visibilityState === "hidden") return;
				inFlight = true;
				let command = null;
				try {
					command = await fetchCommand();
					if (command === null || command === void 0 || command.id === null || command.id === void 0) return;

					if (command.action === "capture") {
						const { payload } = await capture(ctx, command.id);
						const tabCount = Array.isArray(payload.right?.tabs) ? payload.right.tabs.length : 0;
						toast("模型读取了侧边栏（" + String(tabCount) + " 个标签页" + (payload.page ? "，含网页" : "") + "）", true);
						return;
					}

					const data = await runTerminalCommand(ctx, command);
					await sendResult({ commandId: command.id, action: command.action, ok: true, data });
					if (command.action === "terminal-write") toast("模型向终端写入了命令", true);
					else if (command.action === "terminal-open") toast("模型新建了一个终端", true);
					else if (command.action === "terminal-close") toast("模型关闭了一个终端", true);
				} catch (error) {
					const message = String(error && error.message ? error.message : error);
					console.warn("[sidebar-operator] command failed", error);
					const rejected = error !== null && typeof error === "object" && error.rejected === true;
					if (command !== null && command !== void 0 && typeof command.id === "string" && command.action !== "capture") {
						await sendResult({ commandId: command.id, action: command.action, ok: false, rejected, error: message }).catch(() => {});
					}
					toast(rejected ? "你拒绝了模型的终端命令" : "侧栏操作失败：" + message, rejected);
				} finally {
					inFlight = false;
				}
			}, COMMAND_POLL_MS);
			return () => clearInterval(timer);
		}

		function apply(ctx) {
			ctx.effect(() => startCommandPoll(ctx), "ui-sidebar-operator: model command poll");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
