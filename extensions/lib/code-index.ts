/**
 * Semantic code index — chunking, embedding, incremental refresh, cosine search.
 *
 * Kept separate from the extension so it can be tested without a pi instance
 * and without a model (inject a fake embedder). The real one is local:
 * see local-embedder.ts.
 *
 * Storage is two files per repo under ~/.pi/agent/semantic-index/:
 *   <id>.json  chunk metadata (path, line range, preview, file digest)
 *   <id>.bin   embeddings, Float32 row-major, one row per chunk
 * A JSON array of 512-float vectors would be ~10x the size and slow to parse;
 * a flat Float32Array maps straight onto the scoring loop.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative } from "path";

/**
 * The model name is stored in each index and compared on load, so changing it
 * (or the dimension suffix) retires every existing index and rebuilds on next
 * use. Vectors from different models are not comparable; mixing them would
 * rank silently wrong instead of failing.
 *
 * 512 of the model's 768 dimensions: on the comparison that chose this model,
 * 512 ranked exactly as well as 768, while 256 and 128 lost first-place hits.
 */
export const EMBED_MODEL = "google/embeddinggemma-2@512";
export const EMBED_DIMS = 512;
/** Chunks per request. Small enough that progress is reported every few seconds. */
const EMBED_BATCH = 32;
/** How often a long build writes what it has so far. */
const CHECKPOINT_MS = 20_000;

const CODE_EXT = new Set([
	".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".rb",
	".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php",
	".scala", ".sh", ".sql", ".md",
]);

const SKIP_DIR = new Set([
	"node_modules", ".git", ".venv", "venv", ".next", "dist", "build", "out",
	"coverage", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
	"target", "vendor", ".turbo", ".cache", "runs",
]);

/** Definition starts, per language family. Ordered by how strongly they bound a unit. */
const DEF_RE =
	/^(?:\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:def|class|func|fn|function|interface|type|struct|impl|enum|const\s+\w+\s*=\s*(?:async\s*)?\(|let\s+\w+\s*=\s*(?:async\s*)?\()\b/;

const MAX_CHUNK_LINES = 120;
const MIN_CHUNK_LINES = 4;
const FALLBACK_WINDOW = 80;
const FALLBACK_OVERLAP = 20;

export type Chunk = {
	path: string; // repo-relative
	start: number; // 1-based inclusive
	end: number; // 1-based inclusive
	preview: string;
	digest: string; // digest of the whole file, for incremental refresh
};

export type Hit = Chunk & { score: number };

/**
 * Documents and queries are embedded differently (the model is trained with a
 * task prefix on queries and a titled layout on documents), so the embedder is
 * told which it is being handed. Defaults to "document".
 */
export type EmbedKind = "document" | "query";
export type Embedder = (texts: string[], kind?: EmbedKind) => Promise<number[][]>;

/* ------------------------------------------------------------------ files */

export function walkRepo(root: string, maxFiles = 20000): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length && out.length < maxFiles) {
		const dir = stack.pop() as string;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.name.startsWith(".") && e.name !== ".") {
				if (SKIP_DIR.has(e.name)) continue;
			}
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIR.has(e.name)) continue;
				stack.push(full);
			} else if (e.isFile()) {
				const dot = e.name.lastIndexOf(".");
				if (dot < 0) continue;
				if (!CODE_EXT.has(e.name.slice(dot))) continue;
				try {
					if (statSync(full).size > 1_000_000) continue; // generated/minified
				} catch {
					continue;
				}
				out.push(full);
			}
		}
	}
	return out.sort();
}

/* --------------------------------------------------------------- chunking */

/**
 * Split on definition boundaries so a chunk is a coherent unit of code, which
 * is what makes an embedding mean something. Oversized definitions are cut at
 * MAX_CHUNK_LINES; files with no recognisable definitions fall back to
 * overlapping fixed windows.
 */
export function chunkFile(text: string, path: string, digest: string): Chunk[] {
	const lines = text.split("\n");
	if (lines.length === 0) return [];

	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (DEF_RE.test(lines[i] as string)) starts.push(i);
	}

	const ranges: Array<[number, number]> = [];
	if (starts.length === 0) {
		for (let i = 0; i < lines.length; i += FALLBACK_WINDOW - FALLBACK_OVERLAP) {
			ranges.push([i, Math.min(lines.length - 1, i + FALLBACK_WINDOW - 1)]);
			if (i + FALLBACK_WINDOW >= lines.length) break;
		}
	} else {
		// Leading module-level code (imports, constants) is its own chunk.
		if (starts[0]! > 0) ranges.push([0, starts[0]! - 1]);
		for (let s = 0; s < starts.length; s++) {
			const from = starts[s] as number;
			const to = (s + 1 < starts.length ? (starts[s + 1] as number) - 1 : lines.length - 1);
			for (let a = from; a <= to; a += MAX_CHUNK_LINES) {
				ranges.push([a, Math.min(to, a + MAX_CHUNK_LINES - 1)]);
			}
		}
	}

	const chunks: Chunk[] = [];
	for (const [a, b] of ranges) {
		const body = lines.slice(a, b + 1);
		if (body.length < MIN_CHUNK_LINES && chunks.length > 0) continue;
		if (body.join("").trim() === "") continue;
		chunks.push({
			path,
			start: a + 1,
			end: b + 1,
			preview: body.slice(0, 12).join("\n").slice(0, 600),
			digest,
		});
	}
	return chunks;
}

/** What actually gets embedded — path included so the model sees location context. */
export function chunkText(c: Chunk, body: string): string {
	return `${c.path}:${c.start}-${c.end}\n${body}`;
}

/* ---------------------------------------------------------------- storage */

export function indexDir(): string {
	return join(homedir(), ".pi", "agent", "semantic-index");
}

export function indexPaths(repoRoot: string) {
	const id = createHash("sha1").update(repoRoot).digest("hex").slice(0, 16);
	const dir = indexDir();
	return { meta: join(dir, `${id}.json`), vec: join(dir, `${id}.bin`), dir };
}

type Meta = { repoRoot: string; model: string; dims: number; chunks: Chunk[] };

export function loadIndex(repoRoot: string): { meta: Meta; vecs: Float32Array } | null {
	const { meta, vec } = indexPaths(repoRoot);
	if (!existsSync(meta) || !existsSync(vec)) return null;
	try {
		const m = JSON.parse(readFileSync(meta, "utf8")) as Meta;
		const buf = readFileSync(vec);
		const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
		if (vecs.length !== m.chunks.length * m.dims) return null;
		return { meta: m, vecs };
	} catch {
		return null;
	}
}

export function saveIndex(repoRoot: string, chunks: Chunk[], vecs: Float32Array, dims = EMBED_DIMS) {
	const p = indexPaths(repoRoot);
	mkdirSync(p.dir, { recursive: true });
	const meta: Meta = { repoRoot, model: EMBED_MODEL, dims, chunks };
	writeFileSync(p.meta, JSON.stringify(meta));
	writeFileSync(p.vec, Buffer.from(vecs.buffer, vecs.byteOffset, vecs.byteLength));
}

/* --------------------------------------------------------------- indexing */

function fileDigest(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function l2norm(v: number[]): Float32Array {
	let s = 0;
	for (const x of v) s += x * x;
	const n = Math.sqrt(s) || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / n;
	return out;
}

/**
 * Bring the index up to date with the working tree and return it.
 *
 * Freshness is decided by file digest at query time rather than by watching
 * edits: the agent is editing code mid-session, and a digest check also catches
 * changes made outside the session (git checkout, another editor, a second
 * agent). Re-embedding is per changed file, so a normal edit costs one small
 * batch.
 */
export async function refreshIndex(
	repoRoot: string,
	embed: Embedder,
	onProgress?: (done: number, total: number) => void,
	opts: { checkpointMs?: number; batch?: number } = {},
): Promise<{ chunks: Chunk[]; vecs: Float32Array; embedded: number; reused: number }> {
	const checkpointMs = opts.checkpointMs ?? CHECKPOINT_MS;
	const batchSize = opts.batch ?? EMBED_BATCH;
	const existing = loadIndex(repoRoot);
	const prevByFile = new Map<string, { chunks: Chunk[]; rows: Float32Array[] }>();
	if (existing && existing.meta.model === EMBED_MODEL) {
		existing.meta.chunks.forEach((c, i) => {
			const e = prevByFile.get(c.path) ?? { chunks: [], rows: [] };
			e.chunks.push(c);
			e.rows.push(existing.vecs.subarray(i * existing.meta.dims, (i + 1) * existing.meta.dims));
			prevByFile.set(c.path, e);
		});
	}

	const files = walkRepo(repoRoot);
	const outChunks: Chunk[] = [];
	const outRows: Float32Array[] = [];
	const pending: Array<{ chunk: Chunk; text: string }> = [];
	let reused = 0;

	for (const abs of files) {
		let text: string;
		try {
			text = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		const rel = relative(repoRoot, abs);
		const digest = fileDigest(text);
		const prev = prevByFile.get(rel);
		if (prev && prev.chunks[0]?.digest === digest) {
			prev.chunks.forEach((c, i) => {
				outChunks.push(c);
				outRows.push(prev.rows[i] as Float32Array);
			});
			reused += prev.chunks.length;
			continue;
		}
		const lines = text.split("\n");
		for (const c of chunkFile(text, rel, digest)) {
			pending.push({ chunk: c, text: chunkText(c, lines.slice(c.start - 1, c.end).join("\n")) });
		}
	}

	// Checkpointing. A local first build is minutes, not seconds, and an agent turn can be
	// aborted at any point; without this an interrupted build restarts from zero. Only WHOLE
	// files are written: a file with some of its chunks saved would look complete to the
	// digest check above on the next run, and its missing chunks would never be embedded.
	const totalByFile = new Map<string, number>();
	for (const p of pending) totalByFile.set(p.chunk.path, (totalByFile.get(p.chunk.path) ?? 0) + 1);
	const doneByFile = new Map<string, number>();
	const reusedCount = outChunks.length;
	const flatten = (chunks: Chunk[], rows: Float32Array[]) => {
		const dims = rows[0]?.length ?? EMBED_DIMS;
		const flat = new Float32Array(chunks.length * dims);
		rows.forEach((r, i) => flat.set(r, i * dims));
		return { flat, dims };
	};
	const checkpoint = () => {
		const chunks: Chunk[] = [];
		const rows: Float32Array[] = [];
		outChunks.forEach((c, i) => {
			if (i < reusedCount || doneByFile.get(c.path) === totalByFile.get(c.path)) {
				chunks.push(c);
				rows.push(outRows[i] as Float32Array);
			}
		});
		if (chunks.length === 0) return;
		const { flat, dims } = flatten(chunks, rows);
		saveIndex(repoRoot, chunks, flat, dims);
	};

	let embedded = 0;
	let lastSave = Date.now();
	for (let i = 0; i < pending.length; i += batchSize) {
		const batch = pending.slice(i, i + batchSize);
		const vecs = await embed(batch.map((b) => b.text), "document");
		if (vecs.length !== batch.length) {
			throw new Error(`embedder returned ${vecs.length} vectors for ${batch.length} chunks`);
		}
		batch.forEach((b, j) => {
			outChunks.push(b.chunk);
			outRows.push(l2norm(vecs[j] as number[]));
			doneByFile.set(b.chunk.path, (doneByFile.get(b.chunk.path) ?? 0) + 1);
		});
		embedded += batch.length;
		onProgress?.(embedded, pending.length);
		if (Date.now() - lastSave >= checkpointMs && i + batchSize < pending.length) {
			checkpoint();
			lastSave = Date.now();
		}
	}

	const { flat, dims } = flatten(outChunks, outRows);
	// Also save when nothing was embedded but files were deleted or the model changed and
	// everything was dropped: otherwise the stale index is reloaded and re-pruned every time.
	if (pending.length > 0 || (existing && outChunks.length !== existing.meta.chunks.length)) {
		saveIndex(repoRoot, outChunks, flat, dims);
	}
	return { chunks: outChunks, vecs: flat, embedded, reused };
}

/* ----------------------------------------------------------------- search */

export function search(
	queryVec: number[],
	chunks: Chunk[],
	vecs: Float32Array,
	limit: number,
): Hit[] {
	if (chunks.length === 0) return [];
	const dims = vecs.length / chunks.length;
	const q = l2norm(queryVec);
	const scored: Hit[] = [];
	for (let i = 0; i < chunks.length; i++) {
		let dot = 0;
		const off = i * dims;
		for (let d = 0; d < dims; d++) dot += (q[d] as number) * (vecs[off + d] as number);
		scored.push({ ...(chunks[i] as Chunk), score: dot });
	}
	scored.sort((a, b) => b.score - a.score);

	// One hit per file keeps the list a set of leads rather than five slices of
	// the same function.
	const seen = new Set<string>();
	const out: Hit[] = [];
	for (const h of scored) {
		if (seen.has(h.path)) continue;
		seen.add(h.path);
		out.push(h);
		if (out.length >= limit) break;
	}
	return out;
}

export function formatHits(hits: Hit[]): string {
	if (hits.length === 0) return "No matches. Try grep, or rephrase the description.";
	return hits
		.map((h, i) => {
			const preview = h.preview
				.split("\n")
				.slice(0, 8)
				.map((l) => `     ${l}`)
				.join("\n");
			return `${i + 1}. ${h.path}:${h.start}-${h.end}\n   score ${h.score.toFixed(3)}\n${preview}`;
		})
		.join("\n\n");
}

export { dirname };
