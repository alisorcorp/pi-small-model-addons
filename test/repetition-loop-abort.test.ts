/**
 * Proves (then re-verifies the fix for) two holes in repetition-loop-abort.
 *
 * Both were found in a real pi transcript from a local 2-bit model:
 *   1. Blocked on the 3rd identical call, it issued one throwaway
 *      `python3 -c "print('hello')"` and then re-issued the exact blocked
 *      command, which went through — the consecutive streak had reset.
 *   2. It then alternated `echo done` / `echo test` indefinitely, which a
 *      consecutive-streak counter can never see.
 *
 * The legitimate edit -> re-run -> edit -> re-run loop must keep working.
 */
import extension, { __test as ext__test } from "../extensions/repetition-loop-abort.ts";

const ext = { __test: ext__test };

const handlers: Record<string, any> = {};
extension({ on: (evt: string, fn: any) => (handlers[evt] = fn) } as any);

/** Assistant turns, each a list of [toolName, args] issued in that message. */
type Turn = Array<[string, any]>;

const ctxFor = (turns: Turn[]) =>
	({
		hasUI: false,
		sessionManager: {
			getBranch: () =>
				turns.map((calls) => ({
					type: "message",
					message: {
						role: "assistant",
						content: calls.map(([name, args], i) => ({
							type: "toolCall",
							id: `t${i}`,
							name,
							arguments: args,
						})),
					},
				})),
		},
	}) as any;

const call = (turns: Turn[], toolName: string, input: any) =>
	handlers.tool_call({ toolName, input, toolCallId: "x" }, ctxFor(turns));

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
	if (!cond) failures++;
};

const BAD: [string, any] = ["bash", { command: "python3 -c 'trace()'" }];
const HELLO: [string, any] = ["bash", { command: "python3 -c \"print('hello')\"" }];
const DONE: [string, any] = ["bash", { command: 'echo "done"' }];
const TEST: [string, any] = ["bash", { command: 'echo "test"' }];
const EDIT: [string, any] = ["edit", { path: "a.py", old: "x", new: "y" }];
const RUNTESTS: [string, any] = ["bash", { command: "pytest -q" }];

const run = async () => {
	// Baseline: the original behaviour must be preserved.
	// One prior turn + this call = attempt 2, under the threshold of 3.
	const twice = await call([[BAD]], BAD[0], BAD[1]);
	check("2nd identical call is allowed", twice === undefined, JSON.stringify(twice));

	const thrice = await call([[BAD], [BAD]], BAD[0], BAD[1]);
	check("3rd identical call is blocked", thrice?.block === true, JSON.stringify(thrice));

	// HOLE 1: throwaway command must not re-arm the blocked call.
	const afterHello = await call([[BAD], [BAD], [BAD], [HELLO]], BAD[0], BAD[1]);
	check("blocked call stays blocked after a throwaway print", afterHello?.block === true,
		`got ${JSON.stringify(afterHello)}`);

	const afterTwoThrowaways = await call([[BAD], [BAD], [BAD], [HELLO], [DONE]], BAD[0], BAD[1]);
	check("still blocked after two different throwaways", afterTwoThrowaways?.block === true);

	// HOLE 2: A/B alternation is a loop even though no two turns are adjacent-identical.
	const alternating = await call([[DONE], [TEST], [DONE], [TEST]], DONE[0], DONE[1]);
	check("A/B alternation is blocked", alternating?.block === true,
		`got ${JSON.stringify(alternating)}`);

	const threeCycle = await call([[DONE], [TEST], [HELLO], [DONE], [TEST], [HELLO]], DONE[0], DONE[1]);
	check("A/B/C cycle is blocked", threeCycle?.block === true);

	// A cycle that this call does NOT continue is not blocked.
	const breaksCycle = await call([[DONE], [TEST], [DONE], [TEST]], "bash", { command: "ls -la" });
	check("a genuinely new call during a cycle is allowed", breaksCycle === undefined,
		JSON.stringify(breaksCycle));

	// NO FALSE POSITIVE: edit -> re-run -> edit -> re-run is normal work.
	const legit = await call(
		[[RUNTESTS], [EDIT], [RUNTESTS], [EDIT], [RUNTESTS], [EDIT]],
		RUNTESTS[0],
		RUNTESTS[1],
	);
	check("re-running tests after each edit is allowed", legit === undefined, JSON.stringify(legit));

	// A mutation clears the window even for a previously-blocked call.
	const afterRealChange = await call([[BAD], [BAD], [BAD], [EDIT]], BAD[0], BAD[1]);
	check("a real edit unblocks the retry", afterRealChange === undefined,
		JSON.stringify(afterRealChange));

	// A mutating bash command counts as a change too.
	const afterBashWrite = await call(
		[[BAD], [BAD], [BAD], [["bash", { command: "sed -i '' s/a/b/ f.py" }] as [string, any]]],
		BAD[0],
		BAD[1],
	);
	check("a mutating bash command unblocks the retry", afterBashWrite === undefined,
		JSON.stringify(afterBashWrite));

	// Parallel identical calls in ONE message still count once.
	const parallel = await call([[BAD, BAD, BAD]], BAD[0], BAD[1]);
	check("3 identical calls in one message count as one turn", parallel === undefined,
		JSON.stringify(parallel));

	// ---- The branch as pi actually hands it over ---------------------------
	//
	// pi saves an assistant message on message_end, before it runs that
	// message's tools, so when tool_call fires the branch already ends with the
	// message issuing the call. The fixtures above leave it out. These put it
	// back, with the call's real id, the way a live session does: a run on
	// 2026-10-28 was blocked "at attempt 3" on only the second identical call.

	const live = (prior: Turn[], current: Turn, toolCallId = "live-0") => {
		const branch = [...prior, current].map((calls, ti) => ({
			type: "message",
			message: {
				role: "assistant",
				content: calls.map(([name, args], i) => ({
					type: "toolCall",
					id: ti === prior.length ? `live-${i}` : `t${ti}-${i}`,
					name,
					arguments: args,
				})),
			},
		}));
		const [name, args] = current[Number(toolCallId.split("-")[1])];
		return handlers.tool_call(
			{ toolName: name, input: args, toolCallId },
			{ hasUI: false, sessionManager: { getBranch: () => branch } } as any,
		);
	};

	const liveTwice = await live([[BAD]], [BAD]);
	check("live branch: the 2nd identical call is allowed", liveTwice === undefined, JSON.stringify(liveTwice));

	const liveThrice = await live([[BAD], [BAD]], [BAD]);
	check("live branch: the 3rd identical call is blocked", liveThrice?.block === true, JSON.stringify(liveThrice));
	check(
		"live branch: the reason counts the attempt correctly",
		typeof liveThrice?.reason === "string" && liveThrice.reason.includes("attempt 3 "),
		liveThrice?.reason,
	);

	const liveCycle = await live([[DONE], [TEST], [DONE], [TEST]], [DONE]);
	check("live branch: A/B alternation is blocked", liveCycle?.block === true, JSON.stringify(liveCycle));

	// A mutation in the same message as the stuck call has not run yet when the
	// stuck call is checked, so it must not clear the window.
	const livePaired = await live([[BAD], [BAD]], [BAD, EDIT]);
	check("live branch: pairing the call with an edit does not bypass the guard", livePaired?.block === true,
		JSON.stringify(livePaired));

	// ---- What counts as a workspace change --------------------------------
	//
	// Read-only commands must not clear the window. Models add stderr
	// redirects to nearly every exploratory command, and quoted text is data.
	const readOnly = [
		"ls missing 2>/dev/null",
		"grep -rn foo . 2>&1 | head",
		"find . -name '*.ts' 2>/dev/null | wc -l",
		"cat a.txt >&2",
		"node -v &>/dev/null",
		'echo "make sure this works"',
		'echo "1 > 2"',
		"python3 -c 'print(1 > 2)'",
	];
	for (const command of readOnly) {
		const r = await call([[BAD], [BAD], [["bash", { command }]]], BAD[0], BAD[1]);
		check(`read-only, does not unblock: ${command}`, r?.block === true, JSON.stringify(r));
	}

	const writes = [
		"echo x > out.txt",
		"cat a >> log.txt 2>/dev/null",
		"make build",
		"cd app && make",
		"npm install",
		"rm -rf dist",
	];
	for (const command of writes) {
		const r = await call([[BAD], [BAD], [["bash", { command }]]], BAD[0], BAD[1]);
		check(`a write, unblocks: ${command}`, r === undefined, JSON.stringify(r));
	}

	// ---- Rule 4: a block the model ignores ends the run --------------------
	//
	// The fixtures above carry no tool results, so no block is ever on record.
	// These build real branches: assistant turns followed by the results pi
	// wrote for them, including the reasons this extension actually returned.

	const asst = (...calls: Array<[string, any]>) => ({
		type: "message",
		message: {
			role: "assistant",
			content: calls.map(([name, args], i) => ({ type: "toolCall", id: `t${i}`, name, arguments: args })),
		},
	});
	const res = (text: string, isError = false) => ({
		type: "message",
		message: { role: "toolResult", isError, content: [{ type: "text", text }] },
	});
	const OK = res("ok");
	const BLOCKED = res(thrice.reason, true);
	const onBranch = (entries: any[], toolName: string, input: any, abort = () => {}) =>
		handlers.tool_call(
			{ toolName, input, toolCallId: "x" },
			{ hasUI: false, abort, sessionManager: { getBranch: () => entries } } as any,
		);

	const heeded = await onBranch([asst(BAD), OK, asst(BAD), OK, asst(BAD), BLOCKED], BAD[0], BAD[1]);
	check("a second block still only blocks", heeded?.block === true && !heeded?.terminate,
		JSON.stringify(heeded));

	const ignored = await onBranch(
		[asst(BAD), OK, asst(BAD), OK, asst(BAD), BLOCKED, asst(BAD), BLOCKED],
		BAD[0],
		BAD[1],
	);
	check("the third block since the last change ends the run", ignored?.terminate === true,
		JSON.stringify(ignored));
	check(
		"the stop is recognisable in the transcript",
		typeof ignored?.reason === "string" && ignored.reason.startsWith("repetition-loop-abort: stopping the run"),
		ignored?.reason,
	);

	// The shape observed in the wild: blocks with a throwaway call between them.
	const interleaved = await onBranch(
		[asst(BAD), OK, asst(BAD), OK, asst(BAD), BLOCKED, asst(HELLO), OK, asst(BAD), BLOCKED],
		BAD[0],
		BAD[1],
	);
	check("a throwaway call between blocks does not reset the count", interleaved?.terminate === true,
		JSON.stringify(interleaved));

	const afterEdit = await onBranch(
		[asst(BAD), OK, asst(BAD), OK, asst(BAD), BLOCKED, asst(BAD), BLOCKED, asst(EDIT), OK, asst(BAD), OK, asst(BAD), OK],
		BAD[0],
		BAD[1],
	);
	check("a real change clears the block count", afterEdit?.block === true && !afterEdit?.terminate,
		JSON.stringify(afterEdit));

	// Output that quotes a block reason (grep over this file) is not a block.
	const quoted = res(thrice.reason, false);
	const grepped = await onBranch([asst(BAD), quoted, asst(BAD), quoted], BAD[0], BAD[1]);
	check("a successful result that quotes a block reason is not counted", !grepped?.terminate,
		JSON.stringify(grepped));

	// terminate only takes effect when the whole batch sets it; pairing the
	// stuck call with a fresh one slips past it, so the next stop aborts.
	let aborted = false;
	const stopText = res(ignored.reason, true);
	const slipped = await onBranch(
		[asst(BAD), OK, asst(BAD), OK, asst(BAD), BLOCKED, asst(BAD), BLOCKED, asst(BAD, HELLO), stopText, OK],
		BAD[0],
		BAD[1],
		() => {
			aborted = true;
		},
	);
	check("a stop that did not take is backed by an abort", aborted && slipped?.terminate === true,
		`aborted=${aborted} ${JSON.stringify(slipped)}`);

	const disabledHandlers: Record<string, any> = {};
	process.env.PI_LOOP_STOP_AFTER = "0";
	extension({ on: (evt: string, fn: any) => (disabledHandlers[evt] = fn) } as any);
	delete process.env.PI_LOOP_STOP_AFTER;
	const disabled = await disabledHandlers.tool_call(
		{ toolName: BAD[0], input: BAD[1], toolCallId: "x" },
		{
			hasUI: false,
			sessionManager: { getBranch: () => [asst(BAD), OK, asst(BAD), OK, asst(BAD), BLOCKED, asst(BAD), BLOCKED] },
		} as any,
	);
	check("PI_LOOP_STOP_AFTER=0 keeps blocking without stopping", disabled?.block === true && !disabled?.terminate,
		JSON.stringify(disabled));

	// ---- Rule 3: degenerate text in the live stream ------------------------
	//
	// Both fixtures are the shapes actually observed from Ornith 1.5 asked
	// "Do you see any bugs?" against an 18KB file: one repeated sentence with
	// thinking on, and an A/B alternation of two sentences with thinking off.

	const stream = async (chunks: string[], channel: "text" | "thinking" = "text") => {
		let stopped = false;
		const ctx = {
			hasUI: false,
			abort: () => {
				stopped = true;
			},
		} as any;
		await handlers.message_start?.({} as any, ctx);
		let acc = "";
		for (const c of chunks) {
			acc += c;
			const block = channel === "text" ? { type: "text", text: acc } : { type: "thinking", thinking: acc };
			await handlers.message_update({ message: { content: [block] } } as any, ctx);
			if (stopped) break;
		}
		return { stopped, emitted: acc.length };
	};

	const LOOP_SENTENCE =
		"Actually, let me reconsider the suppression logic once more, because I want to check the case " +
		"where dismissed_until was written but in_meeting is now False (calendar went free).\n\n";

	const looped = await stream(Array(30).fill(LOOP_SENTENCE));
	check("a verbatim repeated sentence aborts the turn", looped.stopped, "not aborted");
	check(
		"it aborts early rather than running the loop out",
		looped.emitted < LOOP_SENTENCE.length * 8,
		`emitted ${looped.emitted} chars`,
	);

	// The same loop inside the reasoning channel — where the first one happened,
	// and where a content-only check would never see it.
	const inThinking = await stream(Array(30).fill(LOOP_SENTENCE), "thinking");
	check("the same loop is caught in the reasoning channel", inThinking.stopped, "not aborted");

	// Thinking off does not remove the loop, it only changes its period.
	const A =
		"Let me now check a potential real bug that could be impactful: the rescan uses setdefault(addr, None) " +
		"- only adds NEW addresses, doesn't overwrite existing. That's fine.\n\n";
	const B =
		"Let me now check a potential real bug that could be impactful: the dismissal flow when the daemon " +
		'receives SIGUSR1 but the block already ended. Let me check the CLAUDE.md claim.\n\n';
	const textAlternating = await stream(Array(20).fill(A + B));
	check("an A/B alternation aborts too", textAlternating.stopped, "not aborted");

	// ---- Rule 3 must not fire on legitimate output -------------------------

	const prose = await stream([
		"The bug is in is_in_meeting: active_end is only advanced for events that have already started, ",
		"so a meeting still inside the early-warning window cannot inflate the dismissal horizon. ",
		"The suppression check then compares latest_end against dismissed_until, which means a later-ending ",
		"meeting entering the window still triggers red. That matches what CLAUDE.md documents, so it is ",
		"intentional rather than a defect. The real problem is elsewhere: read_dismissed_until parses the ",
		"file with datetime.fromisoformat and returns a timezone-aware value, but write_dismissed_until is ",
		"handed active_end, which is already UTC. Round-tripping is therefore safe. Moving on to the BLE ",
		"layer, send_to_lamp retries once and the login sequence matches the documented byte sequence.",
	]);
	check("ordinary prose does not abort", !prose.stopped, "false positive on prose");

	// Repetitive by nature, but each unit is short and they are not identical.
	const table = await stream([
		"| addr | state | rssi |\n",
		...Array(25).fill("| AA:BB:CC:DD:EE:FF | white | -71 |\n"),
	]);
	check(
		"a table of near-identical short rows does not abort",
		!table.stopped,
		"false positive on a repetitive table",
	);

	// Unit-level checks on the detector itself.
	const { normalise, repeatingSuffix, streamedText } = ext.__test;
	check(
		"repeatingSuffix returns the PRIMITIVE period, not a multiple of it",
		repeatingSuffix(normalise("xy" + "ab".repeat(120)), 3) === "ab",
		String(repeatingSuffix(normalise("xy" + "ab".repeat(120)), 3)),
	);
	check(
		"repeatingSuffix requires the repeats to END the string",
		repeatingSuffix(normalise("zzz".repeat(50) + " and then something entirely different follows here"), 3) === null,
		"matched a repeat that had already been left behind",
	);
	check(
		"streamedText reads both channels",
		streamedText({ content: [{ type: "thinking", thinking: "aa" }, { type: "text", text: "bb" }] }) === "aabb",
		streamedText({ content: [{ type: "thinking", thinking: "aa" }, { type: "text", text: "bb" }] }),
	);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
};

void run();
