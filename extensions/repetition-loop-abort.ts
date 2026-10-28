/**
 * Repetition-Loop Abort
 *
 * Detects when the model is thrashing — re-issuing tool calls that cannot make
 * progress — and blocks the call, returning a reason that tells it to change
 * tactics.
 *
 * Implements the repetition-loop abort from the little-coder paper
 * (itayinbarr): small models often thrash on a failing hypothesis, re-running
 * the same command expecting a different result. Three attempts is the default
 * threshold — tune with PI_LOOP_THRESHOLD.
 *
 * Streak semantics (v0.1.4):
 *   Counting is per assistant MESSAGE (turn), not per toolCall block. A single
 *   message emitting several identical calls in parallel counts as ONE entry.
 *   Pure text turns are skipped entirely.
 *
 * Why this is a window and not a consecutive streak (v0.2.1):
 *   The original rule counted CONSECUTIVE identical turns, and documented that
 *   "interleaved non-matching tool-call turns reset the streak". A local model
 *   found that reset: blocked on the 3rd identical call, it issued one throwaway
 *   `python3 -c "print('hello')"`, then re-issued the *exact* blocked command,
 *   which sailed through. It then settled into `echo done` / `echo test`
 *   forever — an A/B alternation whose consecutive streak is 1 by construction,
 *   so the guard was structurally blind to it.
 *
 *   So repetition is now counted over a WINDOW of recent turns, and the window
 *   is cleared only by a turn that CHANGES SOMETHING (a mutating tool, or a
 *   bash command that writes). Merely looking — echo, print, cat, grep, ls, a
 *   re-read — does not re-arm a blocked call, because re-running an identical
 *   command after only looking is still thrash. Repetition therefore means
 *   "you have tried this N times without changing anything".
 *
 *   This keeps the legitimate edit -> re-run -> edit -> re-run loop working:
 *   each edit clears the window, so the re-runs never accumulate.
 *
 * Known limit: a model could still re-arm itself with a trivial *mutation*
 * (`echo x > /tmp/f`). That costs it an actual state change and is not a
 * pattern anything has been observed to stumble into; catching it would need
 * result-aware progress detection, which this hook cannot see.
 *
 * Rule 3 — degenerate text, added in v0.3.0:
 *   The rules above are tool-call rules, and a turn that calls no tools is
 *   invisible to them. A local reasoning model asked an open-ended question
 *   about a large file did exactly that: one assistant message, zero tool
 *   calls, the same sentence emitted verbatim until the run was killed by hand
 *   after several minutes.
 *
 *   Two things that look like fixes are not. Turning the model's thinking mode
 *   off only moves the loop from the reasoning channel to the content channel
 *   -- measured, same prompt, an A/B alternation of two sentences instead of
 *   one repeated sentence. And a decode-time repetition penalty cannot be
 *   sized for it: the observed repeating unit was 37 tokens against mlx-lm's
 *   default 20-token penalty window, and widening that window far enough to
 *   see the cycle also starts penalising the newlines, indentation and
 *   identifiers that ordinary code output is made of.
 *
 *   So this rule watches the stream itself. `message_update` carries the
 *   partial message, text and reasoning alike, and `ctx.abort()` ends the
 *   turn -- the same lever a human reaches for, pulled after three repeats
 *   instead of after several minutes.
 *
 * Rule 4 — stop the run when blocks are ignored, added in v0.3.2:
 *   Rules 1 and 2 block the call and tell the model to change approach, which
 *   assumes the model reads the reason. A 2-bit Qwen3.8-27B reviewing a
 *   41-line file did not: it re-issued one identical bash command 73 times
 *   over 25 minutes, every attempt blocked, until an external 30-minute cap
 *   killed the run. The guard was working and could end nothing, because a
 *   block costs the model nothing and can be ignored indefinitely.
 *
 *   So blocks are counted over the same window as the repeats -- since the
 *   last workspace change, at most PI_LOOP_WINDOW turns -- and the Nth block
 *   in it (default 3, i.e. two ignored instructions) also returns `terminate`,
 *   which ends the agent loop after the current tool batch. That is pi's own
 *   lever for this, and unlike ctx.abort() it keeps the reason in the
 *   transcript instead of replacing it with "Operation aborted".
 *
 *   `terminate` only takes effect when every call in the batch sets it, so a
 *   model that pairs the stuck call with a fresh one would slip past it. If a
 *   stop was already requested inside the window and the model is still
 *   calling tools, ctx.abort() is the backstop.
 *
 *   Blocks are read back from the session -- the tool results this extension
 *   wrote -- rather than kept in memory, for the same reason the repeats are:
 *   the branch is the ground truth, and it survives a reload.
 *
 * Counting fixes, v0.4.1 (both found by a local Qwen3.8-27B review run):
 *   The branch pi hands over at tool_call time already holds the message that
 *   issued the call, so every rule counted the call as its own predecessor and
 *   blocked one attempt early. See history(). And the write detector read
 *   `2>/dev/null`, `2>&1` and quoted text as file writes, so ordinary read-only
 *   exploration kept clearing the window. See INERT_SHELL.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToolCallBlock = {
	type: string;
	id?: string;
	name?: string;
	arguments?: unknown;
};

const DEFAULT_THRESHOLD = 3;
const WINDOW_MULTIPLIER = 4;
const MAX_CYCLE_PERIOD = 4;

/** Rule 4: the block, counted within one window, that ends the run. 0 disables. */
const DEFAULT_STOP_AFTER = 3;

/**
 * Every block reason starts with BLOCK_PREFIX; the one that ends the run starts
 * with STOP_PREFIX. Rule 4 recognises its own earlier results by these, so they
 * are the contract between this extension and its past self -- change them and
 * blocks already in a session stop being counted.
 */
const BLOCK_PREFIX = "repetition-loop-abort:";
const STOP_PREFIX = `${BLOCK_PREFIX} stopping the run`;

/**
 * Rule 3 tuning. Periods are measured in whitespace-normalised characters, so
 * a "period" is roughly a sentence or a short paragraph.
 *
 * TEXT_MIN_PERIOD is the guard against false positives: a repeating unit has
 * to be at least this long before three copies of it count as a loop, which
 * keeps ordinary repetition -- a run of similar table rows, a repeated import,
 * an ASCII rule -- from tripping it. TEXT_REPEATS copies of a 64-character
 * unit is ~192 characters of verbatim self-repetition, which prose does not do
 * by accident.
 */
const TEXT_WINDOW = 6000;
const TEXT_STRIDE = 300;
const TEXT_MIN_PERIOD = 64;
const TEXT_REPEATS = 3;

/** Tools whose whole purpose is to change the workspace. */
const MUTATING_TOOLS = new Set(["write", "edit", "multi_edit", "patch", "apply_patch", "create"]);

/**
 * A bash command that writes. Deliberately an allowlist of *mutating* shapes
 * rather than a denylist of inert ones: anything unrecognised is treated as
 * read-only, so an unknown command cannot silently re-arm a blocked call.
 */
const MUTATING_BASH =
	/(^|[;&|]\s*)(rm|mv|cp|mkdir|rmdir|touch|ln|chmod|chown|tee|install|patch|make)\b|>>?\s*\S|\bsed\s+-i|\bgit\s+(add|commit|checkout|apply|reset|restore|rm|mv)\b|\b(npm|pnpm|yarn|bun|pip|pip3|uv|cargo|go|brew)\s+(i|install|add|remove|uninstall|build)\b|\bdocker\s+(build|run)\b/;

/**
 * The parts of a command that cannot write, removed before MUTATING_BASH looks
 * at it. Without this, `ls x 2>/dev/null` and `grep ... 2>&1` -- which models
 * append to nearly every exploratory command -- read as file writes and kept
 * clearing the window, and so did a `>` or the word `make` inside a quoted
 * string, which is data, not shell.
 */
const INERT_SHELL = [
	/'[^']*'|"(?:[^"\\]|\\.)*"/g, // quoted strings
	/\d*>&\s*-?\d*/g, // fd duplication: 2>&1, >&2
	/(?:\d*|&)>>?\s*\/dev\/null\b/g, // discarded output: 2>/dev/null, &>/dev/null
];

function strippedCommand(command: string): string {
	return INERT_SHELL.reduce((s, re) => s.replace(re, " "), command);
}

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function hashInput(name: string, input: unknown): string {
	try {
		return `${name}::${stableStringify(input)}`;
	} catch {
		return `${name}::<unserializable>`;
	}
}

/** Does this single tool call change the workspace? */
function isMutatingCall(name: string, args: unknown): boolean {
	if (MUTATING_TOOLS.has(name)) return true;
	if (name !== "bash") return false;
	const a = args as Record<string, unknown> | undefined;
	const command = typeof a?.command === "string" ? a.command : typeof a?.cmd === "string" ? a.cmd : "";
	return MUTATING_BASH.test(strippedCommand(command));
}

type Turn = {
	hashes: Set<string>;
	primary: string;
	mutating: boolean;
	/** One of this turn's calls was blocked by this extension. */
	blocked: boolean;
	/** ...with a reason that asked pi to end the run. */
	stopRequested: boolean;
};

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content as StreamBlock[]) if (typeof block?.text === "string") out += block.text;
	return out;
}

type StreamBlock = { type?: string; text?: string; thinking?: string };

/**
 * Everything the model has emitted this message, reasoning included. The
 * reasoning channel is deliberately not excluded: the first loop observed in
 * the wild happened entirely inside it, and a turn that never escapes its own
 * `<think>` block never reaches the content channel at all.
 */
function streamedText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content as StreamBlock[]) {
		if (typeof block?.text === "string") out += block.text;
		else if (typeof block?.thinking === "string") out += block.thinking;
	}
	return out;
}

/** Collapse whitespace so that indentation and blank lines do not hide a cycle. */
function normalise(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The PRIMITIVE block whose last `repeats` copies end the string, or null.
 *
 * Primitive matters, and a test found out why. Scanning upward from a minimum
 * length reported a table of 25 identical rows as a loop: one row was below
 * the minimum, but *two* rows concatenated cleared it, and six rows are three
 * copies of that pair. Any run of k identical short units contains a longer
 * repeating unit, so a length floor applied during the scan can always be
 * stepped over that way.
 *
 * Scanning from p = 1 instead returns the shortest period there is, which is
 * by construction primitive. The caller then judges the real unit: a 34-
 * character table row is structure, a 170-character sentence emitted three
 * times is a loop.
 */
function repeatingSuffix(tail: string, repeats: number): string | null {
	const n = tail.length;
	const maxPeriod = Math.floor(n / repeats);
	for (let p = 1; p <= maxPeriod; p++) {
		// Cheap rejection first: the same character must sit one period back.
		if (tail.charCodeAt(n - 1) !== tail.charCodeAt(n - 1 - p)) continue;
		const last = tail.slice(n - p);
		let matched = true;
		for (let r = 2; r <= repeats; r++) {
			if (tail.slice(n - r * p, n - (r - 1) * p) !== last) {
				matched = false;
				break;
			}
		}
		if (matched) return last;
	}
	return null;
}

/**
 * The branch as it stood before the message issuing this call.
 *
 * pi saves an assistant message on message_end, before it runs that message's
 * tools, so by the time tool_call fires the branch already ends with the very
 * message being checked (and, in a sequential batch, the results of its
 * earlier calls). Counted as history, that message made the incoming call its
 * own previous attempt -- every block landed one call early, with "attempt 3"
 * reported on the second -- and an edit in the same batch, which has not run
 * yet, cleared the window for the stuck call beside it.
 *
 * The message is found by the call's own id, so a branch that does not contain
 * it yet is returned whole.
 */
function history<E extends { type: string }>(branch: E[], toolCallId: string | undefined): E[] {
	if (!toolCallId) return branch;
	for (let i = branch.length - 1; i >= 0; i--) {
		const msg = (branch[i] as { message?: { role?: string; content?: unknown } }).message;
		if (branch[i].type !== "message" || msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		if ((msg.content as ToolCallBlock[]).some((b) => b?.type === "toolCall" && b.id === toolCallId)) {
			return branch.slice(0, i);
		}
	}
	return branch;
}

export default function (pi: ExtensionAPI) {
	const envThreshold = Number.parseInt(process.env.PI_LOOP_THRESHOLD ?? "", 10);
	const threshold = Number.isFinite(envThreshold) && envThreshold >= 2 ? envThreshold : DEFAULT_THRESHOLD;

	const envWindow = Number.parseInt(process.env.PI_LOOP_WINDOW ?? "", 10);
	const windowSize =
		Number.isFinite(envWindow) && envWindow >= threshold ? envWindow : threshold * WINDOW_MULTIPLIER;

	const envStopAfter = Number.parseInt(process.env.PI_LOOP_STOP_AFTER ?? "", 10);
	const stopAfter = Number.isFinite(envStopAfter) && envStopAfter >= 0 ? envStopAfter : DEFAULT_STOP_AFTER;

	pi.on("tool_call", async (event, ctx) => {
		const incoming = hashInput(event.toolName, event.input);

		// One entry per assistant message that issued tool calls.
		const turns: Turn[] = [];
		for (const entry of history(ctx.sessionManager.getBranch(), event.toolCallId)) {
			if (entry.type !== "message") continue;
			const msg = (entry as { message?: { role?: string; content?: unknown; isError?: boolean } }).message;
			if (!msg) continue;

			// A result this extension wrote marks the turn whose call it blocked.
			// isError is required so that ordinary output which merely quotes a
			// block reason -- a grep over this file, say -- is not counted.
			if (msg.role === "toolResult") {
				const owner = turns[turns.length - 1];
				const text = resultText(msg.content);
				if (owner && msg.isError === true && text.startsWith(BLOCK_PREFIX)) {
					owner.blocked = true;
					if (text.startsWith(STOP_PREFIX)) owner.stopRequested = true;
				}
				continue;
			}

			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

			const hashes = new Set<string>();
			let primary = "";
			let mutating = false;
			for (const block of msg.content as ToolCallBlock[]) {
				if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
				const h = hashInput(block.name, block.arguments);
				if (!primary) primary = h;
				hashes.add(h);
				if (isMutatingCall(block.name, block.arguments)) mutating = true;
			}
			if (hashes.size > 0) turns.push({ hashes, primary, mutating, blocked: false, stopRequested: false });
		}

		// The window starts after the most recent turn that changed something,
		// and spans at most `windowSize` turns.
		let start = Math.max(0, turns.length - windowSize);
		for (let i = turns.length - 1; i >= start; i--) {
			if (turns[i].mutating) {
				start = i + 1;
				break;
			}
		}
		const recent = turns.slice(start);

		// Rule 1 — the same call, repeated, with nothing changed in between.
		let repeats = 0;
		for (const t of recent) if (t.hashes.has(incoming)) repeats++;

		let reason = "";
		if (repeats + 1 >= threshold) {
			reason =
				`this is attempt ${repeats + 1} at the identical call to "${event.toolName}" with the same arguments, ` +
				`and nothing in the workspace has changed between those attempts`;
		} else {
			// Rule 2 — a repeating cycle of calls (A,B,A,B... or A,B,C,A,B,C...),
			// which never registers as a repeat streak but is equally stuck.
			const seq = recent.map((t) => t.primary);
			for (let p = 2; p <= MAX_CYCLE_PERIOD; p++) {
				if (seq.length < 2 * p) continue;
				const tail = seq.slice(seq.length - p);
				const prior = seq.slice(seq.length - 2 * p, seq.length - p);
				if (tail.join(" ") !== prior.join(" ")) continue;
				// Would this call continue the cycle?
				if (incoming !== seq[seq.length - p]) continue;
				reason =
					`the last ${2 * p} tool calls are a repeating cycle of ${p} and this call continues it, ` +
					`without changing anything in the workspace`;
				break;
			}
		}

		if (!reason) return undefined;

		// Rule 4 — the model has already been told to change approach, inside
		// this same window, and kept going.
		const blocks = recent.filter((t) => t.blocked).length + 1;
		if (stopAfter > 0 && blocks >= stopAfter) {
			// A stop was requested earlier in the window and did not take -- a
			// mixed batch -- so end it outright.
			if (recent.some((t) => t.stopRequested)) ctx.abort();
			if (ctx.hasUI) {
				ctx.ui.notify(
					`loop-abort: "${event.toolName}" blocked ${blocks} times with nothing changed — stopping the run`,
					"warning",
				);
			}
			return {
				block: true,
				terminate: true,
				reason:
					`${STOP_PREFIX}: ${reason}. This is block ${blocks} since the workspace last changed; ` +
					`the previous ${blocks - 1} asked for a change of approach and none followed. ` +
					`Ending the run here rather than letting it spin.`,
			};
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`loop-abort: "${event.toolName}" is looping without progress — blocking`, "warning");
		}

		return {
			block: true,
			reason:
				`${BLOCK_PREFIX} ${reason}. Repeating it will not change the result. ` +
				`Interleaving a throwaway command (echo, print, ls) does not count as changing anything — ` +
				`it will not unblock this call. ` +
				`Change your approach: inspect the last tool result carefully, try different arguments, ` +
				`use a different tool, edit the code, or explain what is blocking you.`,
		};
	});

	// --- Rule 3: degenerate text in the live stream -------------------------
	//
	// State is per message and reset by message_start. `checkedAt` throttles the
	// scan: message_update fires per chunk, and rescanning the tail on every
	// token would cost more than the loop it is looking for.
	let checkedAt = 0;
	let aborted = false;

	const envMinPeriod = Number.parseInt(process.env.PI_LOOP_TEXT_MIN_PERIOD ?? "", 10);
	const minPeriod = Number.isFinite(envMinPeriod) && envMinPeriod >= 8 ? envMinPeriod : TEXT_MIN_PERIOD;

	const envRepeats = Number.parseInt(process.env.PI_LOOP_TEXT_REPEATS ?? "", 10);
	const textRepeats = Number.isFinite(envRepeats) && envRepeats >= 2 ? envRepeats : TEXT_REPEATS;

	const textLoopDisabled = process.env.PI_LOOP_TEXT === "off";

	pi.on("message_start", () => {
		checkedAt = 0;
		aborted = false;
	});

	pi.on("message_update", (event, ctx) => {
		if (textLoopDisabled || aborted) return;

		const text = normalise(streamedText((event as { message?: unknown }).message));
		if (text.length < checkedAt + TEXT_STRIDE) return;
		checkedAt = text.length;

		const tail = text.length > TEXT_WINDOW ? text.slice(text.length - TEXT_WINDOW) : text;
		if (tail.length < minPeriod * textRepeats) return;

		const unit = repeatingSuffix(tail, textRepeats);
		// A short primitive unit is structure -- table rows, a repeated import,
		// an ASCII rule -- not a model talking to itself.
		if (!unit || unit.length < minPeriod) return;

		// Abort once. ctx.abort() ends the turn; a second call from a chunk
		// already in flight would be noise.
		aborted = true;
		const preview = unit.length > 120 ? `${unit.slice(0, 117)}...` : unit;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`loop-abort: the model repeated the same ${unit.length}-character passage ` +
					`${textRepeats}x with no tool call — aborting the turn. Repeated: "${preview}"`,
				"warning",
			);
		}
		ctx.abort();
	});
}

export const __test = { normalise, repeatingSuffix, streamedText };
