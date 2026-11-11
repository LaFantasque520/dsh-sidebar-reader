// ============================================================================
// dsh-sidebar-operator · 宿主部分
//
// 一个插件做两件事：
//   1) sidebar_read —— 读当前会话的侧栏：标签页、终端屏幕、浏览器网页正文
//   2) terminal_{list,write,open,close} —— 真正操作侧栏终端（写入/新建/关闭）
//
// 模型 <-> 客户端走「信箱」：三个内存槽
//   latest          最新一份侧栏快照（客户端 POST 上来，sidebar_read 取走）
//   pendingCommand  待执行命令（模型下发，客户端 1.5s 轮询领走）
//   results         commandId -> 执行结果（客户端回传，工具轮询取走）
//
// 为什么必须过桥：remote.terminal / sidebarRight 都是渲染进程的 cordis 服务，
// 宿主进程拿不到；agent 工具却跑在宿主。
// ============================================================================

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 快照里网页正文的截断上限（字符）。 */
const MAX_TEXT_CHARS = 200000;
/** 结果槽上限，防止长时间运行后无限增长。 */
const MAX_RESULTS = 64;
/** 审计日志：每条请求与结果一行 NDJSON。 */
const AUDIT_PATH = join(homedir(), ".dsh", "sidebar-operator-audit.log");

/** 最新侧栏快照。 */
let latest = null;
/** 待执行命令；客户端领走即清空。 */
let pendingCommand = null;
/** commandId -> { ok, rejected, data, error }。 */
const results = new Map();

/** 审批文案语言：宿主没有可读的 UI locale，退回系统区域设置。 */
const UI_LOCALE = (() => {
	try {
		return String(Intl.DateTimeFormat().resolvedOptions().locale || "en");
	} catch {
		return "en";
	}
})();
const UI_ZH = /^zh/i.test(UI_LOCALE);
const pick = (zh, en) => (UI_ZH ? zh : en);

/** 即使不带路径也会破坏系统或脱离 shell 语义的命令头。 */
const DESTRUCTIVE_HEADS = new Set([
	"format", "diskpart", "shutdown", "bcdedit", "reg", "sc", "net", "takeown",
	"icacls", "wmic", "schtasks", "cipher", "certutil", "bitsadmin", "powershell",
	"pwsh", "cmd"
]);

/** 追加一条审计记录；失败不影响主流程。 */
function audit(record) {
	try {
		appendFileSync(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n", "utf8");
	} catch {
		/* 日志失败不阻断命令 */
	}
}

function genId() {
	return "so-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 统一 JSON 响应。 */
function json(res, req, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(req.method === "HEAD" ? void 0 : payload);
}

/** 读取并解析 JSON 请求体。 */
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

// ---------------------------------------------------------------------------
// 沙箱对齐判定（terminal_write 用）
// ---------------------------------------------------------------------------

/** 按空白切词，保留引号内整体。 */
function tokenize(text) {
	const out = [];
	let current = "";
	let quote = null;
	for (const ch of String(text ?? "")) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (current.length > 0) {
				out.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current.length > 0) out.push(current);
	return out;
}

function looksLikePath(token) {
	return /[\\/]/.test(token) || /^[a-zA-Z]:/.test(token) || /^\\\\/.test(token);
}

function normalizePath(p) {
	let s = String(p).replace(/\//g, "\\").replace(/\\+$/, "");
	s = s.replace(/^([a-zA-Z]):/, (m, d) => d.toLowerCase() + ":");
	return s;
}

function isInside(child, root) {
	const c = normalizePath(child).toLowerCase();
	const r = normalizePath(root).toLowerCase();
	return c === r || c.startsWith(r.endsWith("\\") ? r : r + "\\");
}

/**
 * 用沙箱策略判断这次写入要不要确认：与当前策略一致的命令直接跑，越界/破坏性的才弹审批。
 * @param {object|undefined} policy - sandboxPolicy.resolve({session}) 的结果
 * @param {string} text - 模型要键入的原文
 * @returns {string|null} null=放行；否则是给审批 UI 的理由
 */
function sandboxReason(policy, text) {
	const raw = String(text ?? "").replace(/\r/g, "").trim();
	if (raw.length === 0) return pick("空命令", "empty command");
	if (policy?.mode === "danger-full-access") return null;
	const tokens = tokenize(raw);
	const head = (tokens[0] ?? "").toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
	if (DESTRUCTIVE_HEADS.has(head)) {
		return pick("可能破坏系统的命令（" + head + "）：" + raw, "potentially destructive command (" + head + "): " + raw);
	}
	const root = typeof policy?.workspaceRoot === "string" ? policy.workspaceRoot : null;
	if (root === null) return pick("无法解析工作区根目录：" + raw, "no workspace root resolved: " + raw);
	for (const token of tokens) {
		if (!looksLikePath(token)) continue;
		const absolute = /^([a-zA-Z]:|\\\\|\/)/.test(token) ? token : root + "\\" + token;
		if (!isInside(absolute, root)) {
			return pick(
				"涉及工作区之外的路径（" + token + "）：" + raw,
				"touches a path outside the workspace (" + token + "): " + raw
			);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// 工具构造
// ---------------------------------------------------------------------------

/**
 * 造一个「下发命令 → 等结果」的终端工具。
 * @param {object} spec - 工具定义 + action + approvalReason
 * @param {object} deps - { approval: () => ctx.approval, sandbox: () => ctx.sandboxPolicy }
 */
function makeTerminalTool(spec, deps) {
	return {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
		timeoutMs: spec.timeoutMs ?? 20000,
		async execute(args, exec) {
			const id = genId();
			const input = args ?? {};
			// 沙箱对齐判定
			let resolvedPolicy;
			try {
				const sandbox = typeof deps?.sandbox === "function" ? deps.sandbox() : undefined;
				resolvedPolicy = sandbox?.resolve?.(exec.agent === undefined ? {} : { session: exec.agent.session });
			} catch {
				resolvedPolicy = undefined;
			}
			const reason = typeof spec.approvalReason === "function" ? spec.approvalReason(input, resolvedPolicy) : null;
			let needsConfirm = false;
			if (reason !== null) {
				const approval = typeof deps?.approval === "function" ? deps.approval() : undefined;
				const canAsk = approval !== undefined && typeof approval.request === "function" && exec.agent !== undefined;
				let policy = "ask";
				if (canAsk) {
					try {
						policy = approval.effectivePolicy?.(exec.agent.session) ?? "ask";
					} catch {
						policy = "ask";
					}
				}
				if (canAsk && policy !== "never") {
					let outcome = "unavailable";
					try {
						outcome = await approval.request({
							agent: exec.agent,
							callId: exec.callId,
							toolName: spec.name,
							reason,
							signal: exec.signal
						});
					} catch {
						outcome = "unavailable";
					}
					if (outcome !== "allowed-once") {
						audit({ event: "denied", commandId: id, tool: spec.name, action: spec.action, reason, outcome });
						return JSON.stringify({ approved: false, outcome, reason });
					}
					audit({ event: "approved", commandId: id, tool: spec.name, action: spec.action, reason });
				} else if (!canAsk) {
					// 审批服务不可用：退回客户端自绘弹窗
					needsConfirm = true;
				}
			}
			pendingCommand = { id, action: spec.action, args: input, needsConfirm, at: new Date().toISOString() };
			audit({ event: "request", commandId: id, tool: spec.name, action: spec.action, args: input });
			const deadline = Date.now() + (spec.timeoutMs ?? 20000) - 1500;
			while (Date.now() < deadline) {
				exec.signal.throwIfAborted();
				await sleep(150);
				const settled = results.get(id);
				if (settled !== undefined) {
					results.delete(id);
					if (settled.rejected === true) {
						audit({ event: "rejected", commandId: id, tool: spec.name, action: spec.action });
						return JSON.stringify({ rejected: true, note: "the user declined to run this command" });
					}
					if (!settled.ok) {
						audit({ event: "failed", commandId: id, tool: spec.name, action: spec.action, error: settled.error ?? null });
						throw new Error("sidebar-operator: " + (settled.error ?? "command failed"));
					}
					audit({ event: "done", commandId: id, tool: spec.name, action: spec.action });
					return JSON.stringify(settled.data);
				}
			}
			throw new Error(
				"sidebar-operator: command timed out — the GUI window must be visible and the " +
					"dsh-sidebar-operator plugin loaded in the page."
			);
		},
		presentCall: (args) => ({ card: "generic", title: spec.title, kind: "read", rawInput: args })
	};
}

/** 侧栏读取工具：发 capture 命令，等 latest.commandId 对上。 */
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
		const id = genId();
		pendingCommand = { id, action: "capture", args: {}, needsConfirm: false, at: new Date().toISOString() };
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			exec.signal.throwIfAborted();
			await sleep(300);
			if (latest !== null && latest.commandId === id) break;
		}
		exec.signal.throwIfAborted();
		if (latest === null) throw new Error("sidebar-operator: capture timed out — is the GUI window visible?");
		return JSON.stringify(latest);
	},
	presentCall: (args) => ({ card: "generic", title: "Read sidebar", kind: "read", rawInput: args })
};

/** 组装全部工具。 */
function buildTools(deps) {
	const t = (spec) => makeTerminalTool(spec, deps);
	return [
		SIDEBAR_READ_TOOL,
		t({
			name: "terminal_list",
			title: "List terminals",
			action: "terminal-list",
			timeoutMs: 12000,
			description:
				"List the interactive terminals the Host retains for the current session (id, title, state, " +
				"shell, cwd). Use it to find the terminalId to pass to terminal_write. Reads the current " +
				"session only; nothing leaves this machine.",
			parameters: { type: "object", properties: {} }
		}),
		t({
			name: "terminal_write",
			title: "Write to terminal",
			action: "terminal-write",
			timeoutMs: 180000,
			// 与沙箱策略对齐：工作区内/无路径的命令直接跑，越界或破坏性的才走审批。
			approvalReason: (args, policy) => {
				const reason = sandboxReason(policy, args.text);
				if (reason === null) return null;
				const terminal = String(args.terminalId ?? "?");
				return pick("向终端 " + terminal + " 输入命令：\n" + reason, "type into terminal " + terminal + ":\n" + reason);
			},
			description:
				"Type text into an existing sidebar terminal and return the screen after it settles. Commands " +
				"that stay inside the session workspace run immediately; commands that touch paths outside it, " +
				"or that are destructive, require the user's approval through the native approval UI. " +
				"This is real keyboard input to the user's interactive shell: it takes over terminal input " +
				"while attached and releases it afterwards (the process keeps running). Prefer the pwsh tool " +
				"for one-shot non-interactive commands. Avoid TUI programs (vim/top): line-oriented only.",
			parameters: {
				type: "object",
				properties: {
					terminalId: { type: "string", description: "Target terminal id, from terminal_list or the sidebar tab." },
					text: { type: "string", description: "Raw text to type. Do not include a trailing newline when submit is true." },
					submit: { type: "boolean", description: "Append carriage return so the shell runs the line. Default true." },
					settleMs: { type: "number", description: "Idle time (ms) after the last output before returning. Default 900." },
					timeoutMs: { type: "number", description: "Hard cap (ms) for this single write. Default 15000." }
				},
				required: ["terminalId", "text"]
			}
		}),
		t({
			name: "terminal_open",
			title: "Open terminal",
			action: "terminal-open",
			timeoutMs: 15000,
			description:
				"Open a new interactive terminal as a real sidebar tab (default) and return its terminalId, so " +
				"later terminal_write calls run in an agent-owned shell that the user can watch. Set " +
				"showInSidebar=false only for a headless terminal (Host terminals outside the saved layout have " +
				"no UI entry, so the user cannot see those). Respects the Host limits (max 8 terminals per session).",
			parameters: {
				type: "object",
				properties: {
					showInSidebar: { type: "boolean", description: "Open a visible sidebar tab. Default true." },
					cols: { type: "number", description: "Columns, only used by the headless fallback (default 120, max 500)." },
					rows: { type: "number", description: "Rows, only used by the headless fallback (default 30, max 200)." }
				}
			}
		}),
		t({
			name: "terminal_close",
			title: "Close terminal",
			action: "terminal-close",
			timeoutMs: 15000,
			approvalReason: (args) =>
				pick(
					"关闭终端 " + String(args.terminalId ?? "?") + " —— 会结束它的进程树",
					"close terminal " + String(args.terminalId ?? "?") + " — this kills its process tree"
				),
			description:
				"Close a terminal by id: kills its process range and frees the slot; repeated closes succeed. " +
				"Closing a terminal the user is looking at removes their tab process — confirm intent first.",
			parameters: {
				type: "object",
				properties: { terminalId: { type: "string", description: "Terminal id to close." } },
				required: ["terminalId"]
			}
		})
	];
}

/**
 * 注册信箱路由 + 五个 agent 工具。
 * @param ctx - 所属上下文
 */
function apply(ctx) {
	ctx.inject(["tools"], (toolsCtx) => {
		const tools = toolsCtx.get("tools") ?? toolsCtx.tools;
		const deps = {
			approval: () => (typeof toolsCtx.get === "function" ? toolsCtx.get("approval") : undefined),
			sandbox: () => (typeof toolsCtx.get === "function" ? toolsCtx.get("sandboxPolicy") : undefined)
		};
		for (const tool of buildTools(deps)) {
			// 与 dsh-sidebar-reader 共存时 sidebar_read 会重名：单个失败不能拖垮其余工具。
			try {
				toolsCtx.effect(() => tools.register(tool), "sidebar-operator: " + tool.name);
			} catch (error) {
				console.warn(
					"[sidebar-operator] tool registration skipped (" + tool.name + "):",
					String(error && error.message ? error.message : error)
				);
			}
		}
	});

	ctx.inject(["webServer"], (webCtx) => {
		const server = webCtx.get("webServer");
		webCtx.effect(() => server.register({
			kind: "prefix",
			path: "/sidebar-operator",
			handler: async (req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");
				const pathname = url.pathname;

				if (req.method === "GET" || req.method === "HEAD") {
					if (pathname === "/sidebar-operator/health") {
						json(res, req, 200, { ok: true, hasSnapshot: latest !== null, hasCommand: pendingCommand !== null, results: results.size });
						return;
					}
					if (pathname === "/sidebar-operator/latest") {
						const refresh = url.searchParams.get("refresh") === "1";
						if (!refresh) {
							if (latest === null) json(res, req, 404, { error: "nothing captured yet; add ?refresh=1 to trigger a capture" });
							else json(res, req, 200, latest);
							return;
						}
						const id = genId();
						pendingCommand = { id, action: "capture", args: {}, needsConfirm: false, at: new Date().toISOString() };
						const deadline = Date.now() + 10000;
						while (Date.now() < deadline) {
							await sleep(300);
							if (latest !== null && latest.commandId === id) break;
						}
						if (latest === null) json(res, req, 404, { error: "capture timed out; is the GUI window visible?" });
						else json(res, req, 200, { ...latest, stale: latest.commandId !== id });
						return;
					}
					if (pathname === "/sidebar-operator/command") {
						const command = pendingCommand;
						pendingCommand = null;
						json(res, req, 200, command ?? { id: null });
						return;
					}
					json(res, req, 404, { error: "unknown path; use /health, /latest, /command or POST /result" });
					return;
				}

				if (req.method === "POST" && pathname === "/sidebar-operator/latest") {
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
						sidebar: body.sidebar !== null && typeof body.sidebar === "object" ? body.sidebar : null,
						right: body.right !== null && typeof body.right === "object" ? body.right : null,
						terminals: body.terminals !== null && typeof body.terminals === "object" ? body.terminals : null,
						commandId: typeof body.commandId === "string" ? body.commandId : null,
						receivedAt: new Date().toISOString()
					};
					const tabs = latest.right !== null && Array.isArray(latest.right.tabs) ? latest.right.tabs.length : 0;
					json(res, req, 200, { ok: true, tabs, hasPage: latest.page !== null, chars: latest.page?.chars ?? 0 });
					return;
				}

				if (req.method === "POST" && pathname === "/sidebar-operator/result") {
					const body = await readBody(req, res, 262144);
					if (body === void 0) return;
					const id = typeof body.commandId === "string" ? body.commandId : null;
					if (id === null) {
						json(res, req, 400, { error: "commandId is required" });
						return;
					}
					results.set(id, {
						ok: body.ok === true,
						rejected: body.rejected === true,
						data: body.data !== undefined && body.data !== null ? body.data : null,
						error: typeof body.error === "string" ? body.error.slice(0, 4000) : null
					});
					while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
					json(res, req, 200, { ok: true });
					return;
				}

				json(res, req, 405, { error: "use GET /health|/latest|/command or POST /latest|/result" });
			}
		}), "sidebar-operator: mailbox routes");
	});
}

export { apply };
