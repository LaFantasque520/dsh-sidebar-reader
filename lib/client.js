// ============================================================================
// dsh-sidebar-reader · 客户端部分（运行在 GUI 渲染进程页面里）
//
// 架构总览（与 lib/index.js 宿主路由配合）：
//
//   模型 ──POST /sidebar-reader/command──> 宿主路由 ──客户端 2s 轮询领命令──> 本文件
//                                              ↑                                │ 采集
//                                              └────POST /sidebar-reader/latest─┘
//   模型 <──GET /sidebar-reader/latest────── 宿主路由（内存里只留最新一份快照）
//
// 职责：响应模型的采集命令，一次性抓取三路数据并回传宿主——
//   1. page      侧栏浏览器 webview 的网页正文（桌面端才有）
//   2. right     官方右侧栏当前会话打开的标签（sidebarRight 服务，活数据）
//   3. terminals 本会话每个终端的全屏文本（remote.terminal attach 基线快照）
//
// 设计纪律：
//   - 三路采集各自 try/catch 降级，一路失败不影响其他路；
//   - 所有数据先按「当前屏幕上的会话」过滤，其他会话的数据不出浏览器；
//   - 无任何常驻 UI（按钮已移除），每次采集弹 toast 告知用户，保持透明；
//   - 全部副作用（定时器）挂在 ctx.effect 上，插件禁用即自动清理。
// ============================================================================

// 客户端插件加载约定：宿主的模块加载器调用 factory(require)，
// 返回的 { apply, inject } 就是本插件的客户端模块。
window.__ModuleLoader__.load({
	id: "@local/dsh-client-ui-sidebar-reader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/inject.ts
		// cordis 注入清单（硬性）：声明了才能访问 ctx 上对应属性，否则加载失败。
		//   sidebarRight      官方右侧栏服务（@deepseek-ai/dsh-client-ui-sidebar-right）
		//                     · mounted   快照：当前绘制在屏幕上的会话 id
		//                     · openTabs  快照：所有已采用会话的打开标签元数据
		//   remote            远程命名空间宿主（Typert 网关）
		//   remote.terminal   终端远程命名空间（@deepseek-ai/dsh-api-terminal-controller）
		// 注意：不依赖 better-sidebar——全部能力来自官方服务。
		const inject = ["sidebarRight", "remote", "remote.terminal"];
		//#endregion
		//#region src/client/read-webview.ts
		// 网页正文抓取上限（字符数），与宿主 index.js 的同名常量呼应（双保险截断）。
		const MAX_TEXT_CHARS = 200000;
		// 注入到 <webview> 客户页面里执行的一次性脚本：抓 title/url/innerText。
		// innerText 已是渲染后文本（不含 display:none），对“模型读网页”最合适。
		const READ_SCRIPT = "(() => ({ title: document.title, url: location.href, text: ((document.body ? document.body.innerText : document.documentElement.innerText) || '').slice(0, " + String(MAX_TEXT_CHARS) + "), ready: document.readyState }))()";
		/** 桌面端侧栏浏览器每有一个展示中的 tab 就挂一个 webview。 */
		function findSidebarWebview() {
			// data-sidebar-browser-frame="webview" 是官方 browser 类型 tab 的标记属性。
			const candidates = [...document.querySelectorAll('webview[data-sidebar-browser-frame="webview"]')];
			// 优先取“可见”的那个（用户正在看的页面）；全不可见时退而取最后一个。
			return candidates.find((element) => element.clientWidth > 0 && element.clientHeight > 0) ?? candidates.at(-1) ?? null;
		}
		/**
		 * 读取侧栏浏览器当前网页的 {title, url, text}。
		 * 任何一步不满足（无 webview / 非 Electron 环境 / 页面拒绝执行）都返回
		 * null——纯 Web 端、未开浏览器 tab 属于常态，不算错误。
		 */
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
		//#endregion
		//#region src/client/sidebar-state.ts
		/**
		 * 当前会话 id（官方来源）：`sidebarRight.mounted` 是「屏幕上的会话」的
		 * 可观察快照，主栏被会话占据时为其 id，否则 undefined。
		 * 链式 ?. 全程防御：服务形态变化时安静地返回 null，不抛错。
		 */
		function currentSessionId(ctx) {
			const mounted = ctx.sidebarRight?.mounted?.getSnapshot?.();
			return typeof mounted === "string" && mounted.length > 0 ? mounted : null;
		}
		/**
		 * 官方右侧栏·当前会话打开的标签。
		 * 数据源 `sidebarRight.openTabs`：侧栏自己维护的活标签清单（启动时会用
		 * 持久化布局播种，运行中实时更新），记录形如 {sessionId, id, kind, title,...}。
		 * 按 sessionId 过滤实现「只读当前会话」——其他会话的标签不出浏览器。
		 * 输出字段：
		 *   id       标签记录 id（如 tab3）
		 *   type     kind（editor/text/files/browser/terminal/subagent...）
		 *   title    chip 文本（打开时捕获的地址标题）
		 *   path     contentId 地址（dsh-resource://file/session/<sid>/<path> 等），
		 *            模型按它从磁盘取文件全文
		 *   selected 是否为所在窗格的活动标签
		 */
		function rightSidebarState(ctx) {
			try {
				const sessionId = currentSessionId(ctx);
				if (sessionId === null) return { error: "no session is on screen" };
				const all = ctx.sidebarRight.openTabs.getSnapshot();
				const tabs = (Array.isArray(all) ? all : [])
					.filter((tab) => tab !== null && typeof tab === "object" && tab.sessionId === sessionId)
					.map((tab) => ({
						id: typeof tab.id === "string" ? tab.id : null,
						type: typeof tab.kind === "string" ? tab.kind : null,
						title: typeof tab.title === "string" ? tab.title : null,
						path: typeof tab.contentId === "string" ? tab.contentId : (typeof tab.address === "string" ? tab.address : null),
						selected: tab.selected === true
					}));
				return { sessionId, tabs };
			} catch (error) {
				// 降级约定：采集函数永不抛错，错误进快照让模型看到原因。
				return { error: String(error && error.message ? error.message : error) };
			}
		}
		//#endregion
		//#region src/client/transport.ts
		/** 相对路径 → 绝对 URL（基于 GUI 页面自身的 origin）。 */
		function base(url) {
			return new URL(url, document.baseURI).href;
		}
		/** 把快照 POST 给宿主路由；失败抛错（由轮询的 try/catch 兜住并告警）。 */
		async function sendSnapshot(payload) {
			const response = await fetch(base("sidebar-reader/latest"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.error ?? ("HTTP " + String(response.status)));
			return body;
		}
		/** 向宿主领命令；无命令 / 非法响应一律返回 null（安静空转）。 */
		async function fetchCommand() {
			const response = await fetch(base("sidebar-reader/command"), { cache: "no-store" });
			if (!response.ok) return null;
			return await response.json().catch(() => null);
		}
		//#endregion
		//#region src/client/terminals.ts
		/**
		 * 只读窥探本会话每个宿主保留的终端：
		 *   remote.list(sessionId)          → [{id, title, state, ...}]
		 *   remote.attach(sessionId, id, signal) → 帧流（异步可迭代）
		 * 第一帧 type:"snapshot" 是全屏基线（含滚动缓冲），拿到即停。
		 * 注意事项：
		 *   - Remote 调用返回 {ok:true,value}|{ok:false,error} 包裹，不抛异常；
		 *   - attach 的帧可能是裸帧，也可能包一层 {value:帧}，两种都兼容；
		 *   - 读完立即 abort：断开连接释放终端输入权（副作用：GUI 终端视图
		 *     会显示「接管输入」按钮，用户点一下即恢复）。
		 */
		async function terminalScreens(ctx) {
			try {
				const sessionId = currentSessionId(ctx);
				if (sessionId === null) return { error: "no session is on screen" };
				const remote = ctx.remote?.terminal;
				if (remote === undefined || typeof remote.list !== "function" || typeof remote.attach !== "function")
					return { sessionId, error: "terminal remote namespace unavailable" };
				const listed = await remote.list(sessionId);
				if (listed === null || listed === void 0 || listed.ok !== true || !Array.isArray(listed.value))
					return { sessionId, error: "terminal list failed" };
				const terminals = [];
				for (const info of listed.value) {
					if (info === null || typeof info !== "object" || typeof info.id !== "string") continue;
					// 每个终端一个 4 秒超时：防止某个终端不吐首帧拖死整轮采集。
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 4000);
					try {
						for await (const frame of remote.attach(sessionId, info.id, controller.signal)) {
							// 帧形状归一：裸帧或 {value:帧} 包裹都unwrap成裸帧再判 type。
							const unwrapped = frame !== null && typeof frame === "object" && frame.value !== null && typeof frame.value === "object" && "type" in frame.value ? frame.value : frame;
							if (unwrapped !== null && typeof unwrapped === "object" && unwrapped.type === "snapshot") {
								terminals.push({
									id: info.id,
									title: typeof info.title === "string" ? info.title : null,
									state: typeof info.state === "string" ? info.state : null,
									screen: typeof unwrapped.screen === "string" ? unwrapped.screen.slice(0, 40000) : null
								});
								break; // 只取基线快照，后续增量帧不消费
							}
						}
					} catch (error) {
						// 单个终端失败记录原因，不影响其余终端。
						terminals.push({
							id: info.id,
							title: typeof info.title === "string" ? info.title : null,
							error: String(error && error.message ? error.message : error)
						});
					} finally {
						clearTimeout(timer);
						controller.abort(); // 无条件断开：归还终端输入权
					}
				}
				return { sessionId, terminals };
			} catch (error) {
				return { error: String(error && error.message ? error.message : error) };
			}
		}
		//#endregion
		//#region src/client/capture.ts
		/** 采集编排：三路数据串行抓取（耗时主要是终端 attach，并行收益小）。 */
		async function capture(ctx, commandId) {
			const page = await readSidebarPage();
			const payload = {
				page: page === null ? null : {
					title: page.title,
					url: page.url,
					text: page.text
				},
				right: rightSidebarState(ctx),
				terminals: await terminalScreens(ctx),
				commandId: commandId ?? null // 带回命令 id，模型可核对命令-快照对应关系
			};
			const receipt = await sendSnapshot(payload);
			return { payload, receipt };
		}
		//#endregion
		//#region src/client/toast.ts
		/** 屏幕中下方的临时提示条（2.6s 后淡出）。透明性设计：每次采集用户可见。 */
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
		//#region src/client/command-poll.ts
		const COMMAND_POLL_MS = 2000;
		/**
		 * 命令轮询主循环：模型 POST 一条命令 → 宿主挂起 → 这里 2s 内领走并执行。
		 * 防抖：
		 *   - inFlight：上一轮未结束不叠加（采集含网络等待，可能超过轮询间隔）；
		 *   - visibilityState === "hidden"：GUI 隐藏/最小化时跳过，不白跑。
		 * 返回清理函数（clearInterval），由 apply 的 ctx.effect 托管。
		 */
		function startCommandPoll(ctx) {
			let inFlight = false;
			const timer = setInterval(async () => {
				if (inFlight || document.visibilityState === "hidden") return;
				inFlight = true;
				try {
					const command = await fetchCommand();
					if (command === null || command === void 0 || command.id === null || command.id === void 0) return;
					const { payload } = await capture(ctx, command.id);
					const tabCount = Array.isArray(payload.right?.tabs) ? payload.right.tabs.length : 0;
					toast("模型读取了侧边栏（" + String(tabCount) + " 个标签页" + (payload.page ? "，含网页" : "") + "）", true);
				} catch (error) {
					// 单轮失败只告警不清场：inFlight 在 finally 里复位，下轮继续。
					console.warn("[sidebar-reader] command capture failed", error);
				} finally {
					inFlight = false;
				}
			}, COMMAND_POLL_MS);
			return () => clearInterval(timer);
		}
		//#endregion
		//#region src/client/apply.ts
		/**
		 * cordis 入口：挂载命令轮询；返回的清理函数随 effect 撤销，
		 * 插件禁用/卸载时定时器自动移除。（早期版本还有手动浮动按钮，
		 * 命令通道稳定后已移除——现在采集完全由模型发起。）
		 * @param ctx - 所属上下文，effect 随插件生命周期自动清理。
		 */
		function apply(ctx) {
			ctx.effect(() => startCommandPoll(ctx), "ui-sidebar-reader: model command poll");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
