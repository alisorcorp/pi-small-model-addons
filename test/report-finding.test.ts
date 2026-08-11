import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import extension from "../extensions/report-finding.ts";

const root = join(tmpdir(), "rf-fixture");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "adir"), { recursive: true });
const src = join(root, "app.py");
writeFileSync(
	src,
	["import sys", "", "def load(p):", "    if p is None:", "        return None", "    return open(p).read()", ""].join("\n"),
);

let tool: any;
const hooks: Record<string, any> = {};
extension({ on: (e: string, f: any) => (hooks[e] = f), registerTool: (t: any) => (tool = t) } as any);
if (!tool) throw new Error("no tool registered");

process.env.PI_CLAIM_MEMORY = join(root, "claim-memory.json");
const ctx = { cwd: root, hasUI: false } as any;
const base = {
	claim: "load() crashes on a missing file",
	file: "app.py",
	line: 6,
	quote: "return open(p).read()",
	failing_input: "p='/nope' which does not exist",
	trace: ["p='/nope' passes the None guard", "open('/nope') raises FileNotFoundError"],
	refutation_searched: "lines 4-6 for a guard, and callers of load()",
	refutation_mechanism_found: false,
	refutation_note: "the None guard only covers None, not missing paths",
	provenance: "new",
	confidence: "confirmed",
	severity: "medium",
};

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
	if (!cond) failures++;
};

const run = async (over: any = {}) => tool.execute("id", { ...base, ...over }, undefined, undefined, ctx);
const rejects = async (over: any) => {
	try {
		await run(over);
		return null;
	} catch (e: any) {
		return e.message as string;
	}
};

const main = async () => {
	const ok = await run();
	check("valid finding is accepted", ok?.content?.[0]?.text?.includes("Finding #1 recorded"), JSON.stringify(ok));
	check("records confidence + provenance", ok?.content?.[0]?.text?.includes("(confirmed, new)"));

	const dead = await rejects({ refutation_mechanism_found: true });
	check("self-refuted finding is rejected", !!dead?.includes("disproved"), String(dead));

	const thin = await rejects({ trace: ["it breaks"] });
	check("confirmed with a 1-step trace is rejected", !!thin?.includes("at least 2 steps"), String(thin));

	const sev = await rejects({ confidence: "unverified", severity: "high", trace: [] });
	check("unverified + severity is rejected", !!sev?.includes("cannot carry a severity"), String(sev));

	const hedged = await rejects({ claim: "potential issue with load()" });
	check("hedged claim marked confirmed is rejected", !!hedged?.includes("hedged"), String(hedged));

	const fake = await rejects({ quote: "return open(p).decode('rot13')" });
	check("fabricated quote is rejected", !!fake?.includes("does not appear"), String(fake));

	const nofile = await rejects({ file: "ghost.py" });
	check("nonexistent file is rejected", !!nofile?.includes("could not read"), String(nofile));

	const isdir = await rejects({ file: "adir" });
	check("directory as source file is rejected", !!isdir?.includes("is a directory"), String(isdir));

	const prov = await rejects({ provenance: "maybe" });
	check("bad provenance is rejected", !!prov?.includes("provenance must be"), String(prov));

	const conf = await rejects({ confidence: "high" });
	check("bad confidence is rejected", !!conf?.includes("confidence must be"), String(conf));

	// unverified path: no trace required, no severity
	const unver = await run({ confidence: "unverified", trace: [], severity: undefined });
	check("unverified finding without a trace is allowed", !!unver?.content?.[0]?.text?.includes("unverified"));

	// wrong line number still accepted, but corrected
	const offby = await run({ line: 400 });
	check("wrong line number gets a corrective hint", !!offby?.content?.[0]?.text?.includes("not 400"), offby?.content?.[0]?.text);

	// whitespace-insensitive quote matching
	const ws = await run({ quote: "return   open(p).read()" });
	check("quote matching tolerates whitespace", !!ws?.content?.[0]?.text?.includes("recorded"));

	// tilde path resolution
	const tilde = await rejects({ file: "~/definitely-not-here-xyz.py" });
	check("tilde path resolves (and reports missing)", !!tilde?.includes("could not read"), String(tilde));


	// --- Fable's trace-analysis gaps ---
	const memClaim = await rejects({ claim: "fromisoformat requires Python 3.11+" });
	check("self-answered version claim is rejected", !!memClaim?.includes("from memory"), String(memClaim));

	const memOk = await run({ claim: "fromisoformat requires Python 3.11+", verified_by: "python3 -c '...' -> parsed fine on 3.7" });
	check("version claim WITH a real check is accepted", !!memOk?.content?.[0]?.text?.includes("recorded"));

	const memUnver = await run({ claim: "fromisoformat requires Python 3.11+", confidence: "unverified", trace: [], severity: undefined });
	check("version claim labeled unverified is accepted", !!memUnver?.content?.[0]?.text?.includes("unverified"));

	const doc = await rejects({ refutation_note: "the comment says it's fine" });
	check("comment-as-refutation is rejected", !!doc?.includes("claims under test"), String(doc));

	const doc2 = await rejects({ refutation_searched: "CLAUDE.md documents this behaviour" });
	check("docs-as-search is rejected", !!doc2?.includes("claims under test"), String(doc2));

	// refutations persist for the next session
	await rejects({ claim: "load() leaks a file handle", refutation_mechanism_found: true, refutation_note: "the with-block closes it" });
	const mem = JSON.parse(readFileSync(join(root, "claim-memory.json"), "utf8"));
	check("refutation is persisted", mem.refuted?.some((r: any) => r.claim.includes("leaks a file handle")), JSON.stringify(mem));
	await rejects({ claim: "load() leaks a file handle", refutation_mechanism_found: true, refutation_note: "the with-block closes it" });
	const mem2 = JSON.parse(readFileSync(join(root, "claim-memory.json"), "utf8"));
	check("refutations are de-duplicated", mem2.refuted.length === mem.refuted.length, String(mem2.refuted.length));

	// injection hook surfaces them
	const inj = await hooks.before_agent_start?.({ systemPrompt: "BASE" });
	check("refuted claims are injected into the system prompt", !!inj?.systemPrompt?.includes("leaks a file handle"), String(inj?.systemPrompt).slice(0, 200));
	check("injection preserves the base prompt", !!inj?.systemPrompt?.startsWith("BASE"));


	const exc = await rejects({ claim: "local_tz.localize will raise AmbiguousTimeError on DST transitions" });
	check("exception claim without verified_by is rejected", !!exc?.includes("names a specific exception"), String(exc));

	const excOk = await run({ claim: "local_tz.localize will raise AmbiguousTimeError on DST transitions", verified_by: "python3 -c '...' -> no exception with default is_dst" });
	check("exception claim WITH a run is accepted", !!excOk?.content?.[0]?.text?.includes("recorded"));

	const excUnver = await run({ claim: "load() raises FileNotFoundError", confidence: "unverified", trace: [], severity: undefined });
	check("exception claim labeled unverified is accepted", !!excUnver?.content?.[0]?.text?.includes("unverified"));

	const plain = await run({ claim: "load() returns stale data after the cache expires" });
	check("non-exception claim is unaffected", !!plain?.content?.[0]?.text?.includes("recorded"));

	rmSync(root, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
};

void main();
