// ============================================================================
// dsh-terminal-operator · 宿主部分（运行在 DSH 宿主进程）
//
// 与 dsh-sidebar-reader 同构的「信箱桥」，区别只在能力：这里让模型**写入**终端。
//
//   模型 ──调用 terminal_* 工具──> 宿主：pendingCommand 挂起一条命令
//                                        ▲                    │
//                            GET /terminal-operator/command    │ 客户端 1.5s 轮询领走
//                                        │                    ▼
//   模型 <──工具轮询 results[id]──────┐  POST /terminal-operator/result
//                                     └── 客户端执行完回传结果
//
// 为什么必须过桥：`remote.terminal`（含双工 attach / create / close）只存在于 GUI
// 渲染进程，通过 cordis 注入获得；agent 工具跑在宿主进程，拿不到 ctx.remote。
//
// 真正的写入发生在客户端：attach 终端 → 收 snapshot → handle.send({type:"write",
// sequence, data}) → 等 ack → 读输出 → abort（只释放输入权，不杀进程）。
// ============================================================================

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 单次写入允许的最大字符数（底层 maxInputBytes 默认 65536 字节，留足转义余量）。 */
const MAX_WRITE_CHARS = 4000;
/** 结果槽上限，防止长时间运行后无限增长。 */
const MAX_RESULTS = 64;
/** 审计日志：每条请求与结果一行 NDJSON，落在用户目录下，便于事后核查。 */
const AUDIT_PATH = join(homedir(), ".dsh", "terminal-operator-audit.log");

/** 追加一条审计记录；失败绝不影响主流程。 */
function audit(record) {
	try {
		appendFileSync(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n", "utf8");
	} catch {
		/* 日志失败不阻断命令 */
	}
}

/** 待执行命令；客户端领走即清空（consume-on-read，一条命令只执行一次）。 */
let pendingCommand = null;
/** commandId -> { ok, data, error }；工具轮询取走后删除。 */
const results = new Map();

/** 生成命令 id（客户端执行后原样带回，用于命令↔结果配对）。 */
function genId() {
	return "tc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * 审批文案的界面语言：宿主没有可读的 UI locale 偏好时，退回系统区域设置。
 * 只影响人看的 reason 文本；工具描述对模型保持英文。
 */
const UI_LOCALE = (() => {
	try {
		return String(Intl.DateTimeFormat().resolvedOptions().locale || "en");
	} catch {
		return "en";
	}
})();
const UI_ZH = /^zh/i.test(UI_LOCALE);
/** 中英二选一。 */
const pick = (zh, en) => (UI_ZH ? zh : en);

/** 即使不带路径也会破坏系统或脱离 shell 语义的命令头：一律确认。 */
const DESTRUCTIVE_HEADS = new Set([
	"format", "diskpart", "shutdown", "bcdedit", "reg", "sc", "net", "takeown",
	"icacls", "wmic", "schtasks", "cipher", "certutil", "bitsadmin", "powershell",
	"pwsh", "cmd"
]);

/** 按空白切词，但保留引号内的整体。 */
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

/** 带路径分隔符、盘符或 UNC 前缀的 token 视为路径。 */
function looksLikePath(token) {
	return /[\\/]/.test(token) || /^[a-zA-Z]:/.test(token) || /^\\\\/.test(token);
}

/** 路径归一：统一分隔符、小写盘符、去掉末尾分隔符。 */
function normalizePath(p) {
	let s = String(p).replace(/\//g, "\\").replace(/\\+$/, "");
	s = s.replace(/^([a-zA-Z]):/, (m, d) => d.toLowerCase() + ":");
	return s;
}

/** child 是否等于 root 或位于 root 之下（大小写不敏感）。 */
function isInside(child, root) {
	const c = normalizePath(child).toLowerCase();
	const r = normalizePath(root).toLowerCase();
	return c === r || c.startsWith(r.endsWith("\\") ? r : r + "\\");
}

/**
 * 用沙箱策略判断这次写入要不要确认——目标是复刻 pwsh 的体验：
 * 与当前沙箱策略一致的命令直接跑，越界/危险的才弹审批。
 *
 *   - danger-full-access：沙箱本身不限制，无需确认
 *   - 命中 DESTRUCTIVE_HEADS：确认
 *   - 命令里出现的路径全部落在 workspaceRoot 内，或压根没有路径（作用于 cwd）：放行
 *   - 有任何越界路径：确认
 *
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

/**
 * 造一个「下发命令 → 等结果」的 agent 工具。
 * 需要确认的动作一律走沙箱同一条审批通道（ctx.approval）；
 * 拿不到审批服务时退回客户端自绘弹窗。
 * @param {object} spec - 工具名、描述、参数 schema、命令 action、超时与展示标题。
 * @param {object} deps - { approval: () => ctx.approval, sandbox: () => ctx.sandboxPolicy }
 */
function makeTool(spec, deps) {
	return {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
		timeoutMs: spec.timeoutMs ?? 20000,
		async execute(args, exec) {
			const id = genId();
			const input = args ?? {};
			// 沙箱对齐判定：解析本会话策略，与策略一致的命令直接放行，越界的才走审批。
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
				// 惰性取服务：插件加载时 approval 可能尚未挂载。
				const approval = typeof deps?.approval === "function" ? deps.approval() : undefined;
				const canAsk = approval !== undefined && typeof approval.request === "function" && exec.agent !== undefined;
				// 会话审批策略：'never' 表示用户已关闭审批，此时按预设语义直接放行，
				// 否则 request() 会确定性返回 rejected，插件在 full-access 预设下直接废掉。
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
					// 没有审批服务（或拿不到 agent）时退回客户端自绘弹窗。
					needsConfirm = true;
				}
			}
			// 单槽信箱：新的命令覆盖旧的（agent 工具天然串行，正常不会撞车）。
			pendingCommand = {
				id,
				action: spec.action,
				args: input,
				needsConfirm,
				at: new Date().toISOString()
			};
			// 审计：先记「模型请求了什么」，结果出来再记一条，拒绝也留痕。
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
						throw new Error("terminal-operator: " + (settled.error ?? "command failed"));
					}
					audit({ event: "done", commandId: id, tool: spec.name, action: spec.action });
					return JSON.stringify(settled.data);
				}
			}
			throw new Error(
				"terminal-operator: command timed out — the GUI window must be visible and the " +
					"dsh-terminal-operator plugin loaded in the page."
			);
		},
		presentCall: (args) => ({ card: "generic", title: spec.title, kind: "read", rawInput: args })
	};
}

/**
 * 组装四个工具；approval 为宿主审批服务，缺失时退回客户端弹窗。
 * @param {object} [approval] - ctx.approval
 */
function buildTools(deps) {
	const t = (spec) => makeTool(spec, deps);
	return [
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
			"This is real keyboard input to the user's " +
			"interactive shell: it takes over terminal input while attached and releases it afterwards " +
			"(the process keeps running). Use it when the command must run inside an existing interactive " +
			"session (a sourced environment, an SSH/adb shell, a Python REPL); prefer the pwsh tool for " +
			"one-shot non-interactive commands. Avoid TUI programs (vim/top): line-oriented input only.",
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
		// 关闭会杀掉进程树，属于破坏性操作：永远走审批。
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
 * 注册命令通道路由 + 四个 agent 工具（插件启用期间有效，effect 撤销即注销）。
 * @param ctx - 所属上下文。
 */
function apply(ctx) {
	ctx.inject(["tools"], (toolsCtx) => {
		const tools = toolsCtx.get("tools") ?? toolsCtx.tools;
		const deps = {
			approval: () => (typeof ctx.get === "function" ? ctx.get("approval") : undefined),
			sandbox: () => (typeof ctx.get === "function" ? ctx.get("sandboxPolicy") : undefined)
		};
		for (const tool of buildTools(deps)) {
			toolsCtx.effect(() => tools.register(tool), "terminal-operator: " + tool.name);
		}
	});

	ctx.inject(["webServer"], (webCtx) => {
		const server = webCtx.get("webServer");
		webCtx.effect(() => server.register({
			kind: "prefix",
			path: "/terminal-operator",
			handler: async (req, res) => {
				const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
				if (req.method === "GET" || req.method === "HEAD") {
					if (pathname === "/terminal-operator/health") {
						json(res, req, 200, { ok: true, hasCommand: pendingCommand !== null, results: results.size });
						return;
					}
					if (pathname === "/terminal-operator/command") {
						// 客户端领命令：consume-on-read，保证一条命令恰好被一个轮询周期执行一次。
						const command = pendingCommand;
						pendingCommand = null;
						json(res, req, 200, command ?? { id: null });
						return;
					}
					json(res, req, 404, { error: "unknown path; use GET /command or POST /result" });
					return;
				}
				if (req.method === "POST" && pathname === "/terminal-operator/result") {
					// 客户端交结果：逐字段收敛后放进 results，工具侧按 commandId 取。
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
					// 只留最近 N 条，避免工具超时后堆积。
					while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
					json(res, req, 200, { ok: true });
					return;
				}
				json(res, req, 405, { error: "use GET /command, POST /result" });
			}
		}), "terminal-operator: command + result routes");
	});
}

export { apply };
