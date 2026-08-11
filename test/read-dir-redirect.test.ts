/**
 * Standalone test harness for read-dir-redirect.ts.
 * Loads the extension, captures its tool_result handler, and drives it with
 * synthetic events against a real fixture tree.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import extension from "../extensions/read-dir-redirect.ts";

const root = join(tmpdir(), "rdr-fixture");
rmSync(root, { recursive: true, force: true });

const dir = join(root, "calendar");
mkdirSync(join(dir, "subdir"), { recursive: true });
writeFileSync(join(dir, "notes.md"), "hello");
writeFileSync(join(dir, ".hidden"), "x");
symlinkSync(join(dir, "subdir"), join(dir, "link-to-dir"));
symlinkSync(join(root, "nope"), join(dir, "broken-link"));
mkdirSync(join(root, "empty"), { recursive: true });
const bigDir = join(root, "big");
mkdirSync(bigDir, { recursive: true });
for (let i = 0; i < 10; i++) writeFileSync(join(bigDir, `f${i}.txt`), "");

// Capture the handler the extension registers.
let handler: any;
extension({
	on: (event: string, fn: any) => {
		if (event === "tool_result") handler = fn;
	},
} as any);

if (!handler) throw new Error("extension did not register a tool_result handler");

const ctx = { cwd: root, hasUI: false } as any;
const call = (toolName: string, input: any) =>
	handler({ toolName, input, content: [{ type: "text", text: "EISDIR" }], isError: true }, ctx);

const text = (r: any) => r?.content?.[0]?.text ?? "";
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	if (cond) {
		console.log(`  PASS  ${name}`);
	} else {
		failures++;
		console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const run = async () => {
	// 1. Directory read gets repaired into a successful listing.
	const r1 = await call("read", { path: dir });
	check("directory read is repaired", !!r1);
	check("marked as success (isError false)", r1?.isError === false, `got ${r1?.isError}`);
	check("listing includes plain file", text(r1).includes("notes.md"));
	check("listing includes dotfile", text(r1).includes(".hidden"));
	check("directories get / suffix", text(r1).includes("subdir/"));
	check("symlink-to-dir gets / suffix", text(r1).includes("link-to-dir/"));
	check("broken symlink has no / suffix", /(^|\n)broken-link(\n|$)/.test(text(r1)));
	check("nudges toward ls", text(r1).includes('"ls"'));
	check("details recorded", r1?.details?.readDirRedirect?.total === 5, `total=${r1?.details?.readDirRedirect?.total}`);

	// 2. Relative path resolution.
	const r2 = await call("read", { path: "calendar" });
	check("relative path resolves against cwd", text(r2).includes("notes.md"));

	// 3. Tilde expansion (the case from the screenshot).
	const r3 = await call("read", { path: "~" });
	check("tilde path expands to home", !!r3 && r3.isError === false);
	const r3b = await call("read", { path: `~/${"__definitely_missing__"}` });
	check("missing tilde path is left alone", r3b === undefined);

	// 4. Regular file reads are untouched.
	const r4 = await call("read", { path: join(dir, "notes.md") });
	check("file read is not touched", r4 === undefined);

	// 5. Missing path left to pi's own error.
	const r5 = await call("read", { path: join(root, "does-not-exist") });
	check("missing path is not touched", r5 === undefined);

	// 6. Other tools ignored.
	const r6 = await call("bash", { path: dir });
	check("non-read tool ignored", r6 === undefined);

	// 7. Empty directory.
	const r7 = await call("read", { path: join(root, "empty") });
	check("empty directory handled", text(r7).includes("(empty directory)"));

	// 8. Entry limit truncation.
	process.env.PI_READ_DIR_LIMIT = "3";
	const r8 = await call("read", { path: bigDir });
	check("limit truncates", text(r8).includes("7 more entries not shown"), text(r8).split("\n").pop());
	process.env.PI_READ_DIR_LIMIT = "0"; // invalid -> falls back to default
	const r8b = await call("read", { path: bigDir });
	check("invalid limit falls back to default", !text(r8b).includes("not shown"));
	delete process.env.PI_READ_DIR_LIMIT;

	// 9. file_path alias (some models emit Claude-style args).
	const r9 = await call("read", { file_path: dir });
	check("file_path alias handled", text(r9).includes("notes.md"));

	// 10. Malformed input.
	const r10 = await call("read", {});
	check("missing path arg ignored", r10 === undefined);
	const r10b = await call("read", { path: 42 });
	check("non-string path ignored", r10b === undefined);

	// 11. @-prefixed path (pi strips it).
	const r11 = await call("read", { path: `@${dir}` });
	check("@-prefixed path handled", text(r11).includes("notes.md"));

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	rmSync(root, { recursive: true, force: true });
	process.exit(failures === 0 ? 0 : 1);
};

void run();
