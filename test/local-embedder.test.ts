/**
 * The local embedder's process management, against a stand-in worker that
 * speaks the same JSON-lines protocol without loading a model.
 *
 * What matters here is everything around the model: that documents and queries
 * are told apart, that one bad request does not poison the worker, and that
 * every way the worker can go wrong becomes an error the tool can report
 * instead of a hang.
 */
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createLocalEmbedder } from "../extensions/lib/local-embedder.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.PI_EMBED_WORKER = join(HERE, "fixtures-fake-embed-worker.py");
process.env.PI_EMBED_PYTHON = execFileSync("/usr/bin/which", ["python3"]).toString().trim();

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
	if (!cond) failures++;
};
const rejects = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
		return "";
	} catch (e) {
		return (e as Error).message || "error";
	}
};

const run = async () => {
	process.env.FAKE_WORKER_MODE = "ok";
	const e = createLocalEmbedder(6);
	check("worker is not started until first use", !e.running());

	const docs = await e.embed(["abc", "hello"]);
	check("returns one vector per text, in order", docs.length === 2 && docs[0]![0] === 3 && docs[1]![0] === 5,
		JSON.stringify(docs));
	check("requested dimensions are passed through", docs[0]!.length === 6, `got ${docs[0]!.length}`);
	check("texts default to documents", docs[0]![1] === 0);

	const q = await e.embed(["find it"], "query");
	check("queries are marked as queries", q[0]![1] === 1, JSON.stringify(q));
	check("the worker is reused across calls", e.running());

	const empty = await e.embed([]);
	check("an empty batch is answered without a round trip", empty.length === 0);

	const [a, b] = await Promise.all([e.embed(["x"]), e.embed(["yyyy"], "query")]);
	check("concurrent requests get their own answers", a![0]![0] === 1 && b![0]![0] === 4 && b![0]![1] === 1,
		JSON.stringify([a, b]));

	const bad = await rejects(e.embed(["ok", "FAIL"]));
	check("a request the worker rejects becomes an error", bad.includes("bad text"), bad);
	const after = await e.embed(["still alive"]);
	check("and the worker keeps serving afterwards", after.length === 1 && after[0]![0] === 11);

	e.dispose();
	check("dispose stops the worker", !e.running());

	process.env.FAKE_WORKER_MODE = "short";
	const s = createLocalEmbedder(4);
	const short = await rejects(s.embed(["a", "b", "c"]));
	check("a short response is an error, not misaligned vectors", short.includes("2 vectors for 3"), short);
	s.dispose();

	process.env.FAKE_WORKER_MODE = "die-on-start";
	const d = createLocalEmbedder(4);
	const dead = await rejects(d.embed(["a"]));
	check("a worker that dies while loading reports why", dead.includes("cannot load model"), dead);
	process.env.FAKE_WORKER_MODE = "ok";
	const recovered = await d.embed(["abcd"]);
	check("a failed start is retried on the next call, not cached", recovered[0]![0] === 4);
	d.dispose();

	process.env.FAKE_WORKER_MODE = "die-on-request";
	const r = createLocalEmbedder(4);
	const mid = await rejects(r.embed(["a"]));
	check("a worker that dies mid-request rejects instead of hanging", mid.includes("exited"), mid);
	r.dispose();

	process.env.FAKE_WORKER_MODE = "ok";
	const savedPython = process.env.PI_EMBED_PYTHON;
	process.env.PI_EMBED_PYTHON = "/nonexistent/python";
	const m = createLocalEmbedder(4);
	const missing = await rejects(m.embed(["a"]));
	check("a missing Python names the setup script", missing.includes("setup-embedder.sh"), missing);
	m.dispose();
	process.env.PI_EMBED_PYTHON = savedPython;

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
};

void run();
