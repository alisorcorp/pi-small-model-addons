/**
 * Build or refresh a repository's semantic index ahead of time.
 *
 *   node --experimental-strip-types scripts/semantic-index.ts [repo ...]
 *
 * semantic_code_search builds the index on first use, but a first build runs on
 * the local GPU at a few chunks a second, which is a long time to hold an agent
 * turn. Run this once per large repository instead; later searches only embed
 * what changed. Builds checkpoint, so an interrupted run resumes.
 */
import { resolve } from "path";
import { EMBED_DIMS, EMBED_MODEL, refreshIndex } from "../extensions/lib/code-index.ts";
import { createLocalEmbedder } from "../extensions/lib/local-embedder.ts";

const roots = (process.argv.slice(2).length ? process.argv.slice(2) : [process.cwd()]).map((r) => resolve(r));
const embedder = createLocalEmbedder(EMBED_DIMS);
let failed = false;

for (const root of roots) {
	const started = Date.now();
	let last = 0;
	process.stdout.write(`${root}\n`);
	try {
		const r = await refreshIndex(root, embedder.embed, (done, total) => {
			if (Date.now() - last < 5000 && done < total) return;
			last = Date.now();
			const secs = (Date.now() - started) / 1000;
			process.stdout.write(`  ${done}/${total} chunks  ${secs.toFixed(0)}s  ${(done / Math.max(secs, 1e-9)).toFixed(1)}/s\n`);
		});
		const secs = ((Date.now() - started) / 1000).toFixed(0);
		process.stdout.write(
			`  ${r.chunks.length} chunks indexed with ${EMBED_MODEL}: ${r.embedded} embedded, ${r.reused} reused, ${secs}s\n`,
		);
	} catch (e) {
		failed = true;
		process.stderr.write(`  failed: ${(e as Error).message}\n`);
	}
}

embedder.dispose();
process.exit(failed ? 1 : 0);
