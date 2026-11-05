// ============================================================================
// dsh-sidebar-reader · 宿主部分（运行在 DSH 宿主进程）
//
// 职责：维护两块内存状态 + 四个 HTTP 端点，充当「模型 ↔ 客户端」的信箱。
//   latest         最新一份侧边栏快照（客户端 POST 上来，模型 GET 走）
//   pendingCommand 待执行的采集命令（模型 POST 上来，客户端轮询领走）
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
						// 模型读取快照；尚无快照时 404（区别于 500，属正常空态）。
						if (latest === null) json(res, req, 404, { error: "nothing captured yet" });
						else json(res, req, 200, latest);
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
