/**
 * Semantic Code Search
 *
 * Registers a `semantic_code_search` tool: natural-language description of a
 * symptom, behaviour or intent -> ranked candidate files, with line ranges and
 * a short preview.
 *
 * Why this exists alongside grep: full-text search wins when you already know
 * the identifier, and loses completely when the input is "sometimes the old tax
 * jurisdiction is still used after a billing address change" and you do not yet
 * know a single symbol. The failure mode without it is a long chain of guessed
 * greps, each cheap, collectively the bulk of a coding agent's turns on an
 * unfamiliar repo.
 *
 * Deliberately NOT a retrieval-augmented dump. It returns paths, line ranges,
 * a score and ~8 lines of preview, and tells the model to read what looks
 * relevant. The model stays the navigator; this only shortens the search.
 *
 * PRIVACY: indexing sends repository content to the embedding provider
 * (voyage-code-4, via OpenRouter). It is skipped entirely unless the tool is
 * called, and PI_SEMANTIC_SEARCH_ROOTS can restrict it to named repositories.
 */

import { existsSync, statSync } from "fs";
import { resolve } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatHits,
	loadIndex,
	openRouterEmbedder,
	refreshIndex,
	resolveApiKey,
	search,
} from "./lib/code-index.ts";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function allowedRoot(root: string): boolean {
	const allow = process.env.PI_SEMANTIC_SEARCH_ROOTS;
	if (!allow) return true;
	return allow
		.split(":")
		.map((p) => p.trim())
		.filter(Boolean)
		.some((p) => resolve(root) === resolve(p) || resolve(root).startsWith(resolve(p) + "/"));
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "semantic_code_search",
		label: "Semantic Code Search",
		description:
			"Find code by describing what it does, when you do not know the symbol names yet. " +
			"Returns candidate files with line ranges and a short preview, ranked by similarity. " +
			"Use grep instead when you already know an exact identifier, string or path.",
		promptSnippet: "Find code by describing behaviour when you do not know the symbol names",
		promptGuidelines: [
			"Use grep when you know an exact identifier, symbol, path, string, or error message.",
			"Use semantic_code_search when the user describes behaviour, a bug, architecture, intent, or a symptom and you do not yet know the relevant symbols.",
			"Treat semantic search results as candidates, not facts — the score says a chunk reads like the query, not that it contains the bug.",
			"After semantic_code_search, read the candidate files before making any claim about them or changing them.",
			"For unfamiliar repository-wide tasks, prefer one semantic search over many broad greps.",
		],
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Describe the behaviour, symptom or intent in natural language, as you would to a colleague. " +
						"Not a regex, not a bare identifier.",
				},
				limit: {
					type: "number",
					description: `How many candidate files to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
				},
			},
			required: ["query"],
		},
		async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const args = (params ?? {}) as { query?: unknown; limit?: unknown };
			const query = typeof args.query === "string" ? args.query.trim() : "";
			if (!query) return text("semantic_code_search: `query` must be a non-empty description.");

			const limit = Math.max(
				1,
				Math.min(MAX_LIMIT, typeof args.limit === "number" ? args.limit : DEFAULT_LIMIT),
			);

			const root = ctx?.cwd ?? process.cwd();
			if (!existsSync(root) || !statSync(root).isDirectory()) {
				return text(`semantic_code_search: ${root} is not a directory.`);
			}
			if (!allowedRoot(root)) {
				return text(
					`semantic_code_search is not enabled for ${root}. ` +
						`Indexing uploads repository content to the embedding provider, and ` +
						`PI_SEMANTIC_SEARCH_ROOTS restricts that to specific repositories. Use grep here.`,
				);
			}

			const apiKey = resolveApiKey();
			if (!apiKey) {
				return text(
					"semantic_code_search: no OpenRouter API key found. Set OPENROUTER_API_KEY, or add an " +
						"openrouter provider with an apiKey to ~/.pi/agent/models.json. Use grep meanwhile.",
				);
			}
			const embed = openRouterEmbedder(apiKey);

			// A cold index on a large repo is a long upload; say so rather than
			// stalling the turn silently.
			if (!loadIndex(root) && ctx?.hasUI) {
				ctx.ui?.notify?.("semantic_code_search: building the index (first run)…", "info");
			}

			let chunks: any[];
			let vecs: Float32Array;
			let embedded = 0;
			try {
				const r = await refreshIndex(root, embed);
				chunks = r.chunks;
				vecs = r.vecs;
				embedded = r.embedded;
			} catch (e) {
				return text(
					`semantic_code_search: indexing failed (${(e as Error).message}). Use grep instead.`,
				);
			}
			if (chunks.length === 0) {
				return text("semantic_code_search: no indexable source files found here.");
			}

			let qvec: number[];
			try {
				qvec = (await embed([query]))[0] as number[];
			} catch (e) {
				return text(
					`semantic_code_search: query embedding failed (${(e as Error).message}). Use grep instead.`,
				);
			}

			const hits = search(qvec, chunks, vecs, limit);
			const note = embedded > 0 ? ` (indexed ${embedded} new chunk${embedded === 1 ? "" : "s"})` : "";
			return text(
				`semantic_code_search results for: ${query}${note}\n` +
					`These are candidates ranked by similarity. Read the ones that look relevant before ` +
					`drawing conclusions — a high score means the code reads like the query, not that it is the cause.\n\n` +
					formatHits(hits),
			);
		},
	});
}
