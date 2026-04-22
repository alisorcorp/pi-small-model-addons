/**
 * Write-vs-Edit Guard
 *
 * Intercepts `write` tool calls and blocks them if the target file already
 * exists, returning a structured reason that tells the model to use `edit`
 * instead. Implements the Write-vs-Edit invariant from the little-coder
 * paper (itayinbarr): prevents small models from silently overwriting
 * partially-working code with a whole-file rewrite during exploration.
 *
 * Also closes the common bypass where a small model, seeing the block,
 * falls back to `bash rm <path>` and then retries `write`. Paths observed
 * being deleted or moved away via bash in the current session are tracked
 * and treated as if they still existed for guard purposes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";

const PROTECTED_SEGMENTS = [".git/", "node_modules/"];

const RM_PATTERN = /\brm\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/g;
const MV_SRC_PATTERN = /\bmv\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)\s+[^\s;&|<>]+/g;

function toAbs(cwd: string, p: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

export default function (pi: ExtensionAPI) {
	const deleted = new Set<string>();

	pi.on("session_start", async () => {
		deleted.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const cmd = event.input?.command;
			if (typeof cmd === "string") {
				for (const m of cmd.matchAll(RM_PATTERN)) deleted.add(toAbs(ctx.cwd, m[1]));
				for (const m of cmd.matchAll(MV_SRC_PATTERN)) deleted.add(toAbs(ctx.cwd, m[1]));
			}
			return undefined;
		}

		if (event.toolName !== "write") return undefined;

		const rawPath = event.input?.path;
		if (typeof rawPath !== "string" || !rawPath) return undefined;

		const absolute = toAbs(ctx.cwd, rawPath);

		if (PROTECTED_SEGMENTS.some((seg) => absolute.includes(seg))) {
			return {
				block: true,
				reason: `write blocked: "${rawPath}" is inside a protected directory (${PROTECTED_SEGMENTS.join(", ")}). Pi-mono's little-coder-style guard does not allow writes here.`,
			};
		}

		const priorDeleted = deleted.has(absolute);
		if (priorDeleted) {
			return {
				block: true,
				reason:
					`write blocked: "${rawPath}" was deleted or moved via bash earlier in this session and this call is reconstructing it. ` +
					`This usually means the original Write→Edit guard fired and the model tried to bypass it by deleting the file first. ` +
					`Use the "edit" tool on the original file instead. ` +
					`If you genuinely need a fresh file at this path, call write on a different path first, or explain your intent — do not retry this exact call.`,
			};
		}

		if (!existsSync(absolute)) return undefined;

		let kind = "file";
		try {
			kind = statSync(absolute).isDirectory() ? "directory" : "file";
		} catch {
			// fall through
		}

		if (kind === "directory") {
			return {
				block: true,
				reason: `write blocked: "${rawPath}" is an existing directory.`,
			};
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`write→edit guard: redirecting write on existing file "${rawPath}"`, "warning");
		}

		return {
			block: true,
			reason:
				`write blocked: "${rawPath}" already exists. ` +
				`Use the "edit" tool instead to modify it. ` +
				`Pass the existing text as old_string and the new text as new_string. ` +
				`If you want to replace the whole file, read it first, then call edit with the full old contents as old_string. ` +
				`Do not retry write on this path, and do not attempt to delete the file with bash to get around this guard — that is also blocked.`,
		};
	});
}
