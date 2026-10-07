/**
 * Local embedder — EmbeddingGemma 2 in a Python worker, on this machine.
 *
 * Replaces the OpenRouter/voyage-code-4 embedder, so indexing no longer uploads
 * repository content anywhere. Measured against the Voyage index on a
 * 4,491-chunk repository with 17 described-behaviour queries: the right file
 * ranked first 71% of the time against Voyage's 53%, and in the top five 94%
 * against 88%, with queries answered in ~10 ms each instead of a network round
 * trip. Truncating to 512 dimensions lost nothing; 256 and 128 did.
 *
 * The cost moved rather than disappeared: the first index of a repository is
 * built on the local GPU (~6 chunks/s on an M4 Max, slower on long chunks),
 * where Voyage did it server-side.
 *
 * One worker is started lazily on first use and kept for the life of the
 * process, because loading the model is the slow part (~3 s) and a search is
 * otherwise a few milliseconds. It is killed on dispose() and on process exit.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import type { Embedder } from "./code-index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Loading the model is seconds; a cold start that also downloads it is minutes. */
const READY_TIMEOUT_MS = 10 * 60_000;
/** One request is at most EMBED_BATCH chunks; long chunks on a busy GPU are slow, not stuck. */
const REQUEST_TIMEOUT_MS = 15 * 60_000;

export function embedPython(): string {
	return process.env.PI_EMBED_PYTHON || join(homedir(), ".pi", "agent", "embed-venv", "bin", "python");
}

function workerScript(): string {
	return process.env.PI_EMBED_WORKER || join(HERE, "embed_worker.py");
}

export const SETUP_HINT =
	"Set it up once with scripts/setup-embedder.sh from pi-small-model-addons " +
	"(creates ~/.pi/agent/embed-venv), or point PI_EMBED_PYTHON at a Python that has " +
	"sentence-transformers, torch and pillow installed.";

type Pending = { resolve: (v: number[][]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export type LocalEmbedder = { embed: Embedder; dispose: () => void; running: () => boolean };

export function createLocalEmbedder(dims: number): LocalEmbedder {
	let child: ChildProcessWithoutNullStreams | null = null;
	let ready: Promise<void> | null = null;
	let nextId = 1;
	let stderrTail = "";
	const pending = new Map<number, Pending>();

	const failAll = (err: Error) => {
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		pending.clear();
	};

	const stop = () => {
		const c = child;
		child = null;
		ready = null;
		if (c && c.exitCode === null) c.kill();
	};

	const onExit = () => stop();

	const start = (): Promise<void> => {
		if (ready) return ready;
		const python = embedPython();
		const script = workerScript();
		if (!existsSync(python)) {
			return Promise.reject(new Error(`no embedding Python at ${python}. ${SETUP_HINT}`));
		}
		if (!existsSync(script)) {
			return Promise.reject(new Error(`embedding worker not found at ${script}`));
		}

		ready = new Promise<void>((resolve, reject) => {
			let settled = false;
			const c = spawn(python, ["-u", script], {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					// A ceiling on GPU memory so a bad batch fails instead of swapping the
					// machine. It is a share of what Metal recommends for ALL processes, so
					// it has to leave room for a model server loaded alongside.
					PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0.5",
					PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.4",
					TOKENIZERS_PARALLELISM: "false",
					...process.env,
				},
			});
			child = c;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				stop();
				reject(new Error(`embedding worker not ready after ${READY_TIMEOUT_MS / 1000}s`));
			}, READY_TIMEOUT_MS);

			c.stderr.on("data", (d: Buffer) => {
				stderrTail = (stderrTail + d.toString()).slice(-2000);
			});

			createInterface({ input: c.stdout }).on("line", (line) => {
				let msg: { ready?: boolean; id?: number; vectors?: number[][]; error?: string };
				try {
					msg = JSON.parse(line);
				} catch {
					return; // a library printed to stdout; not ours
				}
				if (msg.ready && !settled) {
					settled = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				if (typeof msg.id !== "number") return;
				const p = pending.get(msg.id);
				if (!p) return;
				pending.delete(msg.id);
				clearTimeout(p.timer);
				if (msg.error) p.reject(new Error(msg.error));
				else if (Array.isArray(msg.vectors)) p.resolve(msg.vectors);
				else p.reject(new Error("embedding worker sent a malformed response"));
			});

			const died = (why: string) => {
				if (child === c) {
					child = null;
					ready = null;
				}
				const tail = stderrTail.trim().split("\n").slice(-3).join(" | ");
				const err = new Error(`embedding worker ${why}${tail ? `: ${tail}` : ""}`);
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(err);
				}
				failAll(err);
			};
			c.on("error", (e) => died(`failed to start (${e.message})`));
			c.on("exit", (code, sig) => died(`exited (${sig ?? `code ${code}`})`));
			// A write to a worker that has just died must not take the host down.
			c.stdin.on("error", () => {});
		});
		// A failed start must not be cached, or every later call replays the same rejection.
		ready.catch(() => {
			ready = null;
		});
		return ready;
	};

	process.once("exit", onExit);

	const embed: Embedder = async (texts, kind = "document") => {
		if (texts.length === 0) return [];
		await start();
		const c = child;
		if (!c) throw new Error("embedding worker is not running");
		const id = nextId++;
		return new Promise<number[][]>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`embedding request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
			}, REQUEST_TIMEOUT_MS);
			pending.set(id, {
				timer,
				reject,
				resolve: (vectors) => {
					if (vectors.length !== texts.length) {
						reject(new Error(`embedding worker returned ${vectors.length} vectors for ${texts.length} texts`));
					} else resolve(vectors);
				},
			});
			c.stdin.write(`${JSON.stringify({ id, kind, texts, dims })}\n`);
		});
	};

	return {
		embed,
		running: () => child !== null,
		dispose: () => {
			process.removeListener("exit", onExit);
			failAll(new Error("embedding worker stopped"));
			stop();
		},
	};
}
