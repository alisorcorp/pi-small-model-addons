/**
 * Repetition-Loop Abort
 *
 * Detects when the model is about to issue the same tool call (same name +
 * same arguments) for the Nth consecutive time and aborts it, returning a
 * reason that tells the model the approach is not working and it should
 * change tactics.
 *
 * Implements the repetition-loop abort from the little-coder paper
 * (itayinbarr): small models often thrash on a failing hypothesis, re-running
 * the same command expecting a different result. Three identical consecutive
 * calls is the default threshold — tune with PI_LOOP_THRESHOLD env var.
 *
 * "Consecutive" means: within the last window of tool calls in the current
 * session branch, counting from the most recent backward, every call up to
 * N-1 was identical to the incoming call. Interleaved unrelated calls reset
 * the streak.
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

		const prior: string[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
			if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const block of msg.content as ToolCallBlock[]) {
				if (block?.type === "toolCall" && typeof block.name === "string") {
					prior.push(hashInput(block.name, block.arguments));
				}
			}
		}

		let streak = 0;
		for (let i = prior.length - 1; i >= 0; i--) {
			if (prior[i] === incoming) streak++;
			else break;
		}

		if (streak < threshold) return undefined;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`loop-abort: "${event.toolName}" called ${threshold}x with identical args — blocking`,
				"warning",
			);
		}

		return {
			block: true,
			reason:
				`repetition-loop-abort: this is the ${threshold}th consecutive identical call to "${event.toolName}" ` +
				`with the same arguments. The previous attempts did not produce the result you expected, ` +
				`and repeating the same call will not change that. ` +
				`Change your approach: inspect the last tool result carefully, try different arguments, ` +
				`use a different tool, or explain what is blocking you. Do not retry this exact call.`,
		};
	});
}
