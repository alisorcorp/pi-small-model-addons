/**
 * Proves (then re-verifies the fix for) the tilde-path hole in write-vs-edit-guard.
 * A `write` to an existing file addressed as ~/... must be blocked.
 */
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import extension from "../extensions/write-vs-edit-guard.ts";

const cwd = join(tmpdir(), "wg-cwd");
rmSync(cwd, { recursive: true, force: true });
mkdirSync(cwd, { recursive: true });

// A real existing file in the home directory, addressed via ~.
const homeRel = ".wg-guard-probe.txt";
const homeAbs = join(homedir(), homeRel);
writeFileSync(homeAbs, "important existing content");

const handlers: Record<string, any> = {};
extension({ on: (evt: string, fn: any) => (handlers[evt] = fn) } as any);

const ctx = { cwd, hasUI: false } as any;
const call = (toolName: string, input: any) =>
	handlers.tool_call({ toolName, input, toolCallId: "t1" }, ctx);

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
	if (!cond) failures++;
};

const run = async () => {
	const tilde = await call("write", { path: `~/${homeRel}` });
	check("write to existing ~/file is blocked", tilde?.block === true, `got ${JSON.stringify(tilde)}`);

	const abs = await call("write", { path: homeAbs });
	check("write to same file by absolute path is blocked", abs?.block === true);

	const fresh = await call("write", { path: `~/${homeRel}.does-not-exist` });
	check("write to non-existent ~/file is allowed", fresh === undefined);

	// Deletion tracking must still line up across path spellings.
	await call("bash", { command: `rm ~/${homeRel}` });
	const afterRm = await call("write", { path: homeAbs });
	check("bash rm via ~ then write via abs path is blocked", afterRm?.block === true);

	rmSync(homeAbs, { force: true });
	rmSync(cwd, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
};

void run();
