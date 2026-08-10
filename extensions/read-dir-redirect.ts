/**
 * Read-Directory Redirect
 *
 * pi's `read` tool has no directory guard, so calling it on a directory
 * surfaces a raw `EISDIR: illegal operation on a directory, read`. Small
 * models reach for `read` on a directory constantly — it is the natural
 * first move when orienting in an unfamiliar project — and the raw errno
 * teaches them nothing, so they burn a whole turn recovering with `ls` or
 * a `bash ls -la`. On a slow local model that round trip costs minutes.
 *
 * This repairs the result instead of punishing it. When `read` targets a
 * directory, the failed result is replaced with the listing the model was
 * actually after, marked as a success, plus a one-line nudge to call `ls`
 * next time. Zero extra turns.
 *
 * Deliberately not a `tool_call` block: pi turns a blocked call into an
 * error tool result, which is the wrong signal here. Reading a directory
 * is a harmless mistake, not a dangerous one — the model wanted a listing
 * and there is no reason to make it ask twice.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";

const DEFAULT_ENTRY_LIMIT = 200;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Mirrors pi's own `resolveToCwd` (tilde expansion, `@` prefix stripping,
 * unicode space normalisation, `file://` URLs). Reimplemented rather than
 * imported because pi does not export its path helpers from the package
 * entry point — only from deep `dist/` paths that are not public API.
 */
function resolveToCwd(input: string, cwd: string): string {
	let p = input.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	if (/^file:\/\//.test(p)) {
		try {
			return fileURLToPath(p);
		} catch {
			// fall through to normal resolution
		}
	}
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function entryLimit(): number {
	const raw = process.env.PI_READ_DIR_LIMIT;
	if (!raw) return DEFAULT_ENTRY_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_ENTRY_LIMIT;
}

/** Alphabetical, dotfiles included, `/` suffix on directories — matches pi's `ls`. */
function listDirectory(absolute: string, limit: number): { lines: string[]; total: number } {
	const entries = readdirSync(absolute, { withFileTypes: true });

	const names = entries
		.map((entry) => {
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = statSync(join(absolute, entry.name)).isDirectory();
				} catch {
					isDir = false; // broken symlink
				}
			}
			return isDir ? `${entry.name}/` : entry.name;
		})
		.sort((a, b) => a.localeCompare(b));

	return { lines: names.slice(0, limit), total: names.length };
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;

		const input = event.input as { path?: unknown; file_path?: unknown } | undefined;
		const rawPath = typeof input?.path === "string" ? input.path : input?.file_path;
		if (typeof rawPath !== "string" || !rawPath) return undefined;

		const absolute = resolveToCwd(rawPath, ctx.cwd);

		try {
			if (!statSync(absolute).isDirectory()) return undefined;
		} catch {
			return undefined; // missing path — leave pi's own error alone
		}

		let listing: { lines: string[]; total: number };
		try {
			listing = listDirectory(absolute, entryLimit());
		} catch (err) {
			// Unreadable directory (permissions, races). Leave the original
			// error in place rather than replacing it with a worse one.
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`read failed: "${rawPath}" is a directory, and listing it also failed (${message}). ` +
							`Use the "ls" tool on a directory you can access.`,
					},
				],
			};
		}

		const { lines, total } = listing;
		const hidden = total - lines.length;

		const body = total === 0 ? "(empty directory)" : lines.join("\n");
		const truncated = hidden > 0 ? `\n... (${hidden} more ${hidden === 1 ? "entry" : "entries"} not shown)` : "";

		if (ctx.hasUI) {
			ctx.ui.notify(`read→ls guard: listed directory "${rawPath}" instead of failing`, "warning");
		}

		return {
			content: [
				{
					type: "text" as const,
					text:
						`"${rawPath}" is a directory, not a file, so "read" does not apply to it. ` +
						`Its contents are listed below — you do not need to call anything else to get this. ` +
						`Use the "ls" tool directly for directories next time, and "read" only for files.\n\n` +
						`${body}${truncated}`,
				},
			],
			details: {
				readDirRedirect: { path: absolute, entries: lines.length, total },
			},
			isError: false,
		};
	});
}
