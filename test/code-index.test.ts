/**
 * Exercises the semantic index without network: a deterministic fake embedder
 * (bag-of-words projected onto fixed dimensions) stands in for voyage-code-4,
 * so chunking, incremental refresh and ranking are all testable offline.
 */
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	chunkFile,
	indexPaths,
	loadIndex,
	refreshIndex,
	search,
	walkRepo,
} from "../extensions/lib/code-index.ts";

const repo = join(tmpdir(), "sem-index-repo");
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, "node_modules", "junk"), { recursive: true });

writeFileSync(
	join(repo, "src", "auth.py"),
	`import os\nimport time\n\n\ndef refresh_session(token):\n    """Rotate the refresh token and extend expiry."""\n    if token.expired:\n        return None\n    token.expires_at = time.time() + 3600\n    return token\n\n\ndef validate_session(token):\n    """Reject sessions past their expiry."""\n    return token.expires_at > time.time()\n`,
);
writeFileSync(
	join(repo, "src", "invoice.py"),
	`def recalculate_invoice(inv):\n    """Recompute totals using the stored tax jurisdiction."""\n    rate = inv.jurisdiction.rate\n    inv.total = inv.subtotal * (1 + rate)\n    return inv.total\n\n\ndef cancel_invoice(inv):\n    inv.status = "cancelled"\n    return inv\n`,
);
writeFileSync(join(repo, "node_modules", "junk", "big.js"), "var x=1;\n".repeat(50));
writeFileSync(join(repo, "notes.txt"), "not indexable\n");

/** Deterministic stand-in: hash each token onto dimensions, count occurrences. */
const DIMS = 64;
const fakeEmbed = async (texts: string[]) =>
	texts.map((t) => {
		const v = new Array(DIMS).fill(0);
		for (const w of t.toLowerCase().match(/[a-z_]{3,}/g) ?? []) {
			let h = 0;
			for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) % DIMS;
			v[h] += 1;
		}
		return v;
	});

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
	if (!cond) failures++;
};

const run = async () => {
	// walk
	const files = walkRepo(repo);
	check("walks source files", files.length === 2, `got ${files.length}: ${files.join(", ")}`);
	check("skips node_modules", !files.some((f) => f.includes("node_modules")));
	check("skips non-code extensions", !files.some((f) => f.endsWith(".txt")));

	// chunking splits on definitions
	const py = `import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return 2\n`;
	const cs = chunkFile(py, "x.py", "d1");
	check("chunks split on def boundaries", cs.length >= 2, `got ${cs.length}`);
	check("chunk line ranges are 1-based and ordered", cs[0]!.start === 1 && cs[0]!.end < cs[1]!.start);

	// full index
	rmSync(indexPaths(repo).meta, { force: true });
	rmSync(indexPaths(repo).vec, { force: true });
	const first = await refreshIndex(repo, fakeEmbed);
	check("first pass embeds every chunk", first.embedded > 0 && first.reused === 0,
		`embedded=${first.embedded} reused=${first.reused}`);
	check("index persists to disk", loadIndex(repo) !== null);

	// incremental: nothing changed
	const second = await refreshIndex(repo, fakeEmbed);
	check("unchanged repo re-embeds nothing", second.embedded === 0 && second.reused > 0,
		`embedded=${second.embedded} reused=${second.reused}`);
	check("chunk count is stable", second.chunks.length === first.chunks.length);

	// incremental: one file edited
	writeFileSync(
		join(repo, "src", "invoice.py"),
		`def recalculate_invoice(inv):\n    """Recompute totals using the CACHED tax jurisdiction."""\n    rate = inv.cached_rate\n    inv.total = inv.subtotal * (1 + rate)\n    return inv.total\n`,
	);
	const third = await refreshIndex(repo, fakeEmbed);
	check("edited file is re-embedded", third.embedded > 0, `embedded=${third.embedded}`);
	check("untouched file is reused", third.reused > 0, `reused=${third.reused}`);

	// ranking: a described symptom should surface the right file
	const q = (await fakeEmbed(["session expiry validation and refresh token rotation"]))[0]!;
	const hits = search(q, third.chunks, third.vecs, 5);
	check("ranks the auth file first for a session query", hits[0]?.path.includes("auth"),
		`got ${hits.map((h) => h.path).join(", ")}`);
	check("one hit per file", new Set(hits.map((h) => h.path)).size === hits.length);
	check("hits carry line ranges", (hits[0]?.start ?? 0) >= 1 && (hits[0]?.end ?? 0) >= (hits[0]?.start ?? 0));

	const q2 = (await fakeEmbed(["invoice total recalculation with tax"]))[0]!;
	const hits2 = search(q2, third.chunks, third.vecs, 5);
	check("ranks the invoice file first for an invoice query", hits2[0]?.path.includes("invoice"),
		`got ${hits2.map((h) => h.path).join(", ")}`);

	rmSync(repo, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
};

void run();
