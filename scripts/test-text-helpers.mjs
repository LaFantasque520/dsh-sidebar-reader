// 文本处理三件套的自测（stripAnsi / capScreen / screenDelta）。
//
// 为什么从 lib/client.js 里抠代码而不是 import：
// 客户端部分整份是「页面脚本」（依赖 window.__ModuleLoader__ 与 DOM），
// 无法在 Node 里加载。这里只把 `src/client/text.ts` 那个 region 原样取出来
// 在函数作用域里求值，测的就是将要上线的同一份代码。
//
// 运行：node scripts/test-text-helpers.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const begin = source.indexOf("//#region src/client/text.ts");
const end = source.indexOf("//#endregion", begin);
assert.ok(begin !== -1 && end > begin, "text region not found in lib/client.js");

const region = source.slice(source.indexOf("\n", begin) + 1, end);
const factory = new Function(`${region}\nreturn { stripAnsi, capScreen, screenDelta, TERMINAL_MAX_LINES, TERMINAL_MAX_CHARS, lastScreens };`);
const { stripAnsi, capScreen, screenDelta, TERMINAL_MAX_LINES, TERMINAL_MAX_CHARS, lastScreens } = factory();

let passed = 0;
function check(name, fn) {
	fn();
	passed += 1;
	console.log(`ok ${passed} - ${name}`);
}

// --- stripAnsi -------------------------------------------------------------
check("SGR colors and CRLF are removed", () => {
	const out = stripAnsi("\u001b[32mhello\u001b[0m\r\nworld");
	assert.equal(out, "hello\nworld");
});

check("OSC title sequence and control chars are removed", () => {
	const out = stripAnsi("\u001b]0;my title\u0007text\u0000\u0007");
	assert.equal(out, "text");
});

check("cursor moves vanish but printable text survives", () => {
	const out = stripAnsi("D:\\tmp\u001b[K\u001b[1;1H> ");
	assert.equal(out, "D:\\tmp> ");
});

check("non-string input becomes empty string", () => {
	assert.equal(stripAnsi(undefined), "");
	assert.equal(stripAnsi(null), "");
});

// --- capScreen -------------------------------------------------------------
check("line cap keeps the tail and flags truncation", () => {
	const text = Array.from({ length: TERMINAL_MAX_LINES + 100 }, (_, i) => `line-${i}`).join("\n");
	const { text: capped, truncated } = capScreen(text, TERMINAL_MAX_LINES, TERMINAL_MAX_CHARS);
	assert.equal(truncated, true);
	assert.equal(capped.split("\n").length, TERMINAL_MAX_LINES);
	assert.equal(capped.split("\n").at(-1), `line-${TERMINAL_MAX_LINES + 99}`);
});

check("char cap keeps the tail with an ellipsis", () => {
	const { text: capped, truncated } = capScreen("x".repeat(TERMINAL_MAX_CHARS + 500), TERMINAL_MAX_LINES, TERMINAL_MAX_CHARS + 1);
	assert.equal(truncated, true);
	assert.equal(capped.length, TERMINAL_MAX_CHARS + 2); // "…" + maxChars
	assert.ok(capped.startsWith("…"));
});

check("short screen is returned untouched", () => {
	const { text: capped, truncated } = capScreen("a\nb", 10, 100);
	assert.equal(capped, "a\nb");
	assert.equal(truncated, false);
});

// --- screenDelta -----------------------------------------------------------
check("first read is a full screen (delta:false)", () => {
	lastScreens.clear();
	const out = screenDelta("t1", "one\ntwo");
	assert.deepEqual(out, { text: "one\ntwo", delta: false });
});

check("appended output yields only the new text", () => {
	lastScreens.clear();
	screenDelta("t2", "one\ntwo");
	const out = screenDelta("t2", "one\ntwo\nthree");
	assert.equal(out.delta, true);
	assert.equal(out.text, "\nthree");
});

check("same screen yields an empty delta", () => {
	lastScreens.clear();
	screenDelta("t3", "one\ntwo");
	const out = screenDelta("t3", "one\ntwo");
	assert.equal(out.delta, true);
	assert.equal(out.text, "");
});

check("in-place redraw falls back to the common line prefix", () => {
	lastScreens.clear();
	screenDelta("t4", "a\nb\nc");
	const out = screenDelta("t4", "a\nb\nd");
	assert.equal(out.delta, true);
	assert.equal(out.text, "d");
});

check("fully different screen is returned whole (never loses text)", () => {
	lastScreens.clear();
	screenDelta("t7", "a\nb\nc");
	const out = screenDelta("t7", "b\nc\nd");
	assert.equal(out.delta, true);
	assert.equal(out.text, "b\nc\nd");
});

check("per-terminal state is independent", () => {
	lastScreens.clear();
	screenDelta("t5", "x");
	const out = screenDelta("t6", "y");
	assert.equal(out.delta, false);
	assert.equal(out.text, "y");
});

console.log(`\n${passed} checks passed`);
