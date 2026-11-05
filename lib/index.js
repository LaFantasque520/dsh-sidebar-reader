// ============================================================================
// dsh-sidebar-reader · 宿主部分（运行在 DSH 宿主进程）
//
// 职责：维护两块内存状态 + 四个 HTTP 端点 + 一个原生 agent 工具，
//       充当「模型 ↔ 客户端」的信箱。
//   latest         最新一份侧边栏快照（客户端 POST 上来，模型 GET 走；
//                  GET /latest?refresh=1 会自动触发一轮采集并等它回来——模型一次 GET 拿新数据）
//   pendingCommand 待执行的采集命令（POST /command 或 GET /latest?refresh=1 下发，客户端轮询领走）
//   sidebar_read   原生 agent 工具：模型在工具清单里直接看到并调用，进程内触发采集。
//                  「读终端/网页先走侧边栏」的偏好编码在工具描述里，不依赖书面规则。
//
// 路由挂在 loopback webServer 上、不过浏览器鉴权（同皮肤资源路由的待遇），
// 因此模型可以用普通 HTTP 工具（curl/irm）直接读写——这是本插件存在的意义：
// 让模型用最平凡的 GET/POST 完成对 GUI 内部状态的观察。
// ============================================================================

// 快照里网页正文的截断上限（字符），与客户端 client.js 的同名常量呼应。
const MAX_TEXT_CHARS = 200000;

/** 最新快照；整体替换是该存储的唯一写语义（没有历史、没有合并）。 */
let latest = null;

/** 待执行命令；客户端领走即清空（consume-on-read，一条命令只执行一次）。 */
let pendingCommand = null;

/**
 * 原生 agent 工具定义（照 @deepseek-ai/dsh-tools 注册表接受的裸定义形状手搓，零依赖）：
 * register() 只硬性要求 output {schema, render}；parameters 为 JSON Schema 对象根。
 * execute 进程内触发一轮采集并等它回来，与 GET /latest?refresh=1 同一逻辑。
 */
const SIDEBAR_READ_TOOL = {
	name: "sidebar_read",
	description:
		"Read the current session's live UI state in one call: the official right-sidebar tabs " +
		"(files, folders, documents, browser and terminal tabs), terminal screens (xterm snapshots " +
		"including scrollback), and the sidebar browser web page text. Use this BEFORE shelling out " +
		"via pwsh or web_fetch whenever the user asks about their terminal or a page they opened in " +
		"the sidebar browser. Reads only the current session; data never leaves this machine; the " +
		"user sees a toast on every read. Web page text is desktop-only (null in a plain browser).",
	parameters: { type: "object", properties: {} },
	output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
	timeoutMs: 20000,
	async execute(_args, exec) {
		// 与 GET /latest?refresh=1 同一逻辑：下发命令 → 轮询 latest.commandId 对上 → 返回快照。
		const id = "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
		pendingCommand = { id, action: "capture", at: new Date().toISOString() };
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			exec.signal.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 300));
			if (latest !== null && latest.commandId === id) break;
		}
		exec.signal.throwIfAborted();
		if (latest === null) throw new Error("sidebar-reader: capture timed out — is the GUI window visible?");
		return JSON.stringify(latest);
	},
	presentCall: (args) => ({ card: "generic", title: "Read sidebar", kind: "read", rawInput: args })
};

/** 统一 JSON 响应：no-store 防缓存，HEAD 只给头不给体。 */
function json(res, req, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(req.method === "HEAD" ? void 0 : payload);
}

/** 读取并解析 JSON 请求体；超限 413、非法 JSON 400，失败返回 undefined（响应已写）。 */
async function readBody(req, res, limitBytes) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += chunk.length;
		if (bytes > limitBytes) {
			json(res, req, 413, { error: "payload too large" });
			return void 0;
		}
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		json(res, req, 400, { error: "body must be JSON" });
		return void 0;
	}
}

/**
 * 注册快照存储与命令通道路由（插件启用期间有效）。
 * @param ctx - 所属上下文，effect 撤销时路由自动注销。
 */
function apply(ctx) {
	// 注册原生 agent 工具：register() 返回注销器，包进 effect——插件禁用即自动注销。
	// 「tools」服务由宿主提供（plugin_market 等官方插件同款注册途径）。
	ctx.inject(["tools"], (toolsCtx) => {
		const tools = toolsCtx.get("tools") ?? toolsCtx.tools;
		toolsCtx.effect(() => tools.register(SIDEBAR_READ_TOOL), "sidebar-reader: sidebar_read agent tool");
	});
	// 等宿主的 webServer 服务就绪再注册路由（注入保证时序）。
	ctx.inject(["webServer"], (webCtx) => {
		const server = webCtx.get("webServer");
		// kind:"prefix" 接管 /sidebar-reader 下所有路径，一个 handler 内按路径分发。
		webCtx.effect(() => server.register({
			kind: "prefix",
			path: "/sidebar-reader",
			handler: async (req, res) => {
				const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
				if (req.method === "GET" || req.method === "HEAD") {
					if (pathname === "/sidebar-reader/health") {
						// 自检端点：模型先探这里判断插件是否活着、状态如何。
						json(res, req, 200, { ok: true, hasSnapshot: latest !== null, hasCommand: pendingCommand !== null });
						return;
					}
					if (pathname === "/sidebar-reader/latest") {
						// 模型读取快照。带 ?refresh=1 时自动触发一轮采集并等它回来：
						// 下发命令 → 每 300ms 检查 latest.commandId 是否对上 → 对上即返回新快照。
						// 模型因此只需一次 GET；不带 refresh 保持原语义（立即返回现有快照）。
						const refresh = new URL(req.url ?? "/", "http://localhost").searchParams.get("refresh") === "1";
						if (!refresh) {
							if (latest === null) json(res, req, 404, { error: "nothing captured yet; add ?refresh=1 to trigger a capture" });
							else json(res, req, 200, latest);
							return;
						}
						const id = "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
						pendingCommand = { id, action: "capture", at: new Date().toISOString() };
						const deadline = Date.now() + 10000;
						while (Date.now() < deadline) {
							await new Promise((resolve) => setTimeout(resolve, 300));
							if (latest !== null && latest.commandId === id) break;
						}
						// 等到新快照原样返回；超时则返回现有快照并标 stale（模型可据此重试）。
						if (latest === null) json(res, req, 404, { error: "capture timed out; is the GUI window visible?" });
						else json(res, req, 200, { ...latest, stale: latest.commandId !== id });
						return;
					}
					if (pathname === "/sidebar-reader/command") {
						// 客户端领命令：consume-on-read——取出即清空，
						// 保证一条命令恰好被一个轮询周期执行一次。
						const command = pendingCommand;
						pendingCommand = null;
						json(res, req, 200, command ?? { id: null });
						return;
					}
					json(res, req, 404, { error: "unknown path; use /latest, /command or /health" });
					return;
				}
				if (req.method === "POST" && pathname === "/sidebar-reader/command") {
					// 模型下发采集命令：本体内容无关紧要，id 才是关键——
					// 客户端执行后把它放进快照，模型据此核对命令↔快照对应。
					const body = await readBody(req, res, 4096);
					if (body === void 0) return;
					pendingCommand = {
						id: "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
						action: "capture",
						at: new Date().toISOString()
					};
					json(res, req, 200, { ok: true, id: pendingCommand.id });
					return;
				}
				if (req.method === "POST" && pathname === "/sidebar-reader/latest") {
					// 客户端交快照：逐字段校验/截断后替换 latest。
					// 上限 = 正文上限 ×4（JSON 转义膨胀余量）+ 终端屏文本的空间。
					const body = await readBody(req, res, (MAX_TEXT_CHARS + 4096) * 4);
					if (body === void 0) return;
					const page = body.page !== null && typeof body.page === "object" ? body.page : null;
					const text = page !== null && typeof page.text === "string" ? page.text.slice(0, MAX_TEXT_CHARS) : "";
					latest = {
						page: page === null ? null : {
							title: typeof page.title === "string" ? page.title : "",
							url: typeof page.url === "string" ? page.url : "",
							text,
							chars: text.length
						},
						sidebar: body.sidebar !== null && typeof body.sidebar === "object" ? body.sidebar : null, // 兼容旧版 better-sidebar 工作列字段
						right: body.right !== null && typeof body.right === "object" ? body.right : null,
						terminals: body.terminals !== null && typeof body.terminals === "object" ? body.terminals : null,
						commandId: typeof body.commandId === "string" ? body.commandId : null,
						receivedAt: new Date().toISOString()
					};
					// 回执摘要：客户端 toast 与模型调试都用得上。
					const tabs = latest.sidebar !== null && Array.isArray(latest.sidebar.tabs) ? latest.sidebar.tabs.length : 0;
					const rightSessions = latest.right !== null ? Object.keys(latest.right).length : 0;
					json(res, req, 200, { ok: true, tabs, rightSessions, hasPage: latest.page !== null, chars: latest.page?.chars ?? 0 });
					return;
				}
				json(res, req, 405, { error: "use GET/POST /latest, GET/POST /command, GET /health" });
			}
		}), "sidebar-reader: snapshot + command routes");
	});
}

export { apply };
