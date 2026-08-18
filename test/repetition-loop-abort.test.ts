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
import extension from "../extensions/repetition-loop-abort.ts";

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

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
};

void run();
