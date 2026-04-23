/**
 * Repetition-Loop Abort
 *
 * Detects when the model is about to issue the same tool call (same name +
 * same arguments) for the Nth consecutive turn and aborts it, returning a
 * reason that tells the model the approach is not working and it should
 * change tactics.
 *
 * Implements the repetition-loop abort from the little-coder paper
 * (itayinbarr): small models often thrash on a failing hypothesis, re-running
 * the same command expecting a different result. Three identical consecutive
 * turns is the default threshold — tune with PI_LOOP_THRESHOLD env var.
 *
 * Streak semantics (v0.1.4):
 *   The streak counts across assistant MESSAGES (turns), not across individual
 *   toolCall content blocks. A single assistant message emitting several
 *   identical tool calls in parallel (common with parallel tool-calling) counts
 *   as ONE streak entry, not N. This avoids a false-positive class where the
 *   very first call of a parallel batch is blocked because the branch at
 *   event-fire time already contains N identical hashes from the same in-flight
 *   message.
 *
 *   Interleaved non-matching tool-call turns reset the streak. Pure text
 *   assistant turns (no tool calls) do not contribute to or break the streak.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ToolCallBlock = {
	type: string;
	id?: string;
	name?: string;
	arguments?: unknown;
};

const DEFAULT_THRESHOLD = 3;

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

export default function (pi: ExtensionAPI) {
	const envThreshold = Number.parseInt(process.env.PI_LOOP_THRESHOLD ?? "", 10);
	const threshold = Number.isFinite(envThreshold) && envThreshold >= 2 ? envThreshold : DEFAULT_THRESHOLD;

	pi.on("tool_call", async (event, ctx) => {
		const incoming = hashInput(event.toolName, event.input);

		// Per-message boolean: does this assistant message contain at least one
		// toolCall whose hash matches `incoming`? Text-only messages are skipped
		// entirely (they don't affect streak in either direction).
		const messageMatches: boolean[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
			if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

			let hasToolCall = false;
			let matched = false;
			for (const block of msg.content as ToolCallBlock[]) {
				if (block?.type === "toolCall" && typeof block.name === "string") {
					hasToolCall = true;
					if (hashInput(block.name, block.arguments) === incoming) {
						matched = true;
						break; // one match per message is enough
					}
				}
			}
			if (hasToolCall) messageMatches.push(matched);
		}

		let streak = 0;
		for (let i = messageMatches.length - 1; i >= 0; i--) {
			if (messageMatches[i]) streak++;
			else break;
		}

		if (streak < threshold) return undefined;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`loop-abort: "${event.toolName}" called on ${threshold} consecutive turns with identical args — blocking`,
				"warning",
			);
		}

		return {
			block: true,
			reason:
				`repetition-loop-abort: this is the ${threshold}th consecutive turn issuing an identical call to "${event.toolName}" ` +
				`with the same arguments. The previous attempts did not produce the result you expected, ` +
				`and repeating the same call will not change that. ` +
				`Change your approach: inspect the last tool result carefully, try different arguments, ` +
				`use a different tool, or explain what is blocking you. Do not retry this exact call.`,
		};
	});
}
