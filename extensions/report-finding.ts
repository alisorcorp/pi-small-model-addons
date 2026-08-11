/**
 * Report-Finding Tool
 *
 * A structured channel for review findings, replacing free prose.
 *
 * The `claim-verification` skill asks for a traced failure scenario and a
 * failed refutation attempt per finding. Small models read that as a posture
 * rather than a procedure: they adopt the vocabulary ("we should verify
 * claims"), hedge the conclusion, and ship untraced "potential issues"
 * anyway. Observed directly — a model ran ~20 refute-the-hypothesis cycles
 * internally, killed most of them correctly, then reported the survivors in
 * prose with no trace, no citation, and no confidence label, at the same
 * apparent confidence as the ones it had actually checked.
 *
 * Instruction cannot fix that, because the model believes it is complying.
 * A tool schema can: pi validates arguments before execution, so a finding
 * that cannot fill every field is rejected by the runtime rather than by the
 * model's own discipline. The reasoning is demonstrably there; what is
 * missing is the output contract, and a contract is exactly what a schema is.
 *
 * Mandatory fields create pressure to fabricate them, so the fields that can
 * be checked mechanically are checked: the quote must actually appear in the
 * cited file, a finding whose own refutation pass found a defeating mechanism
 * is rejected as dead, and `confirmed` requires a real trace.
 *
 * Guidelines are registered via `promptGuidelines`, which lands in the system
 * prompt rather than in progressively-disclosed skill text — a stronger
 * channel for a model that treats skills as optional.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { Type } from "typebox";
import { fileURLToPath } from "url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Same resolution pi uses. Duplicated per the note in write-vs-edit-guard.ts. */
function resolveToCwd(input: string, cwd: string): string {
	let p = input.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	if (/^file:\/\//.test(p)) {
		try {
			return fileURLToPath(p);
		} catch {
			// fall through
		}
	}
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Collapse whitespace so quote matching survives reindentation and wrapping. */
function normalize(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

const HEDGE = /\b(potential|possible|possibly|perhaps|probably|unclear|unsure)\b/i;

/**
 * Claims about language/library/version behaviour, which come from training
 * memory rather than from the repo. Observed failure: the model wrote
 * "fromisoformat works in Python 3.11+? Yes." — it detected its own
 * uncertainty, answered its own question from the same memory that produced
 * the doubt, and shipped the result as fact. A factual question in your own
 * reasoning is a trigger to go check, never something to answer yourself.
 */
const MEMORY_CLAIM =
	/\b\d+\.\d+\+|\b(?:since|before|prior to|as of|requires?|added in|removed in|introduced in)\s+v?\d+\.\d+|\bdeprecat|\brenamed\b|\bbackport/i;

/** Comments and docs are claims under test, not evidence that settles one. */
const DOC_AS_EVIDENCE =
	/\b(?:the\s+)?(?:comment|docstring|doc|docs|documentation|readme|claude\.md|agents\.md)\b[^.]{0,40}\b(?:says?|states?|claims?|notes?|confirms?|asserts?|documents?)\b|\bper the (?:comment|docs?)\b|\bas documented\b/i;

/** Refuted memory-class claims, persisted so a correction outlives the session. */
type Refutation = { claim: string; why: string; at: string };

function memoryPath(): string {
	return process.env.PI_CLAIM_MEMORY || join(homedir(), ".pi", "agent", "claim-memory.json");
}

function loadRefutations(): Refutation[] {
	try {
		const parsed = JSON.parse(readFileSync(memoryPath(), "utf8"));
		return Array.isArray(parsed?.refuted) ? parsed.refuted : [];
	} catch {
		return [];
	}
}

function recordRefutation(entry: Refutation): void {
	try {
		const existing = loadRefutations();
		const key = normalize(entry.claim).toLowerCase();
		if (existing.some((r) => normalize(r.claim).toLowerCase() === key)) return;
		existing.push(entry);
		const path = memoryPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ refuted: existing.slice(-200) }, null, 2));
	} catch {
		// Persistence is a nicety; never fail a tool call over it.
	}
}

export default function (pi: ExtensionAPI) {
	let reported = 0;

	pi.on("session_start", async (event) => {
		const reason = (event as { reason?: string }).reason;
		if (reason === "resume" || reason === "fork" || reason === "reload") return;
		reported = 0;
	});

	// A correction the model accepted last session does not survive into this
	// one — the same false claim came back in a fresh session as a *question*
	// ("works in 3.11+?"). Answering it before the model can answer it wrongly
	// is the only thing that breaks that loop, so past refutations are injected
	// up front rather than left to be rediscovered.
	pi.on("before_agent_start", async (event) => {
		const refuted = loadRefutations().slice(-25);
		if (refuted.length === 0) return undefined;
		const block = refuted.map((r) => `- NOT TRUE: ${r.claim}\n  Why: ${r.why}`).join("\n");
		return {
			systemPrompt:
				`${(event as { systemPrompt?: string }).systemPrompt ?? ""}\n\n` +
				`## Previously refuted claims\n\n` +
				`These were investigated and disproved in earlier sessions. Do not report them as findings, ` +
				`and do not re-derive them from memory — this list is the answer.\n\n${block}\n`,
		};
	});

	pi.registerTool({
		name: "report_finding",
		label: "Report Finding",
		description:
			"Report one code-review, audit, or bug-hunt finding. Every field is required. " +
			"A finding you cannot fully fill in is not a finding — drop it instead of reporting it. " +
			"Call once per finding. Reporting nothing is a valid and correct outcome.",
		promptSnippet: "Report one verified review finding (requires a trace and a refutation attempt)",
		promptGuidelines: [
			"Report every code-review, audit, or bug-hunt finding by calling report_finding once per finding, instead of describing findings in prose.",
			'If you cannot fill in every report_finding field, that finding is unverified: drop it rather than reporting it in prose with hedging words like "potential issue", "might", or "worth noting".',
			"Before calling report_finding, look for the guard, early return, signal handler, or caller-side filter that would defeat the failure — checking a few lines either side of the code you quoted first — and record that search in the refutation fields.",
		],
		parameters: Type.Object({
			claim: Type.String({
				description: "One sentence: what is wrong. State it as fact, not as a possibility.",
			}),
			file: Type.String({ description: "Path to the file containing the proof." }),
			line: Type.Number({ description: "1-indexed line where the quoted code starts." }),
			quote: Type.String({
				description: "The exact source text at that location that proves the claim. Copy it verbatim.",
			}),
			failing_input: Type.String({
				description:
					"A concrete input or state that triggers the failure, e.g. 'a meeting starting in 90s with dismissed_until unset'. Not 'certain conditions'.",
			}),
			trace: Type.Array(Type.String(), {
				description:
					"Step-by-step walk of that input through the quoted code to the wrong output, naming the value at each step.",
			}),
			refutation_searched: Type.String({
				description: "Where you looked for a mechanism that would prevent this failure.",
			}),
			refutation_mechanism_found: Type.Boolean({
				description:
					"True if you found a guard/handler/filter that prevents the failure. If true the finding is dead and will be rejected — do not report it.",
			}),
			refutation_note: Type.String({
				description: "What you found, or why nothing you found defeats the failure.",
			}),
			provenance: Type.String({
				description:
					"'new' if you derived this from the code, or 'restated' if the repo's own docs/comments/CLAUDE.md already describe it.",
			}),
			confidence: Type.String({
				description: "'confirmed' if you produced a real trace and refutation, otherwise 'unverified'.",
			}),
			severity: Type.Optional(
				Type.String({ description: "Only allowed when confidence is 'confirmed'." }),
			),
			verified_by: Type.Optional(
				Type.String({
					description:
						"Required for any claim about language/library/version behaviour: the command you actually ran and its output (e.g. `python3 -c \"...\"` -> result), or the installed source you read. Your memory of version history does not count.",
				}),
			),
		}),

		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: any) {
			const {
				claim,
				file,
				line,
				quote,
				trace,
				refutation_mechanism_found,
				refutation_note,
				provenance,
				confidence,
				severity,
			} = params;

			const reject = (msg: string) => {
				throw new Error(`report_finding rejected: ${msg}`);
			};

			if (provenance !== "new" && provenance !== "restated") {
				reject(`provenance must be "new" or "restated", got "${provenance}".`);
			}
			if (confidence !== "confirmed" && confidence !== "unverified") {
				reject(`confidence must be "confirmed" or "unverified", got "${confidence}".`);
			}

			// A refutation pass that found the defeating mechanism has disproved the
			// finding. Reporting it anyway, softened, is the exact failure this guards.
			// Bank it first: the model's own refutation is the thing worth keeping.
			if (refutation_mechanism_found === true) {
				recordRefutation({ claim: String(claim), why: String(refutation_note), at: new Date().toISOString() });
				reject(
					`your own refutation pass found a mechanism that prevents this failure ("${refutation_note}"), ` +
						`so the finding is disproved. Drop it — do not soften it into a hedge and report it anyway. ` +
						`It has been recorded as refuted so it does not come back next session.`,
				);
			}

			// "The comment says it's fine" is how a real bug gets blessed: docs
			// asserted the guarantee the code failed to keep. A hypothesis is only
			// resolved by tracing the code.
			if (DOC_AS_EVIDENCE.test(String(refutation_note)) || DOC_AS_EVIDENCE.test(String(params.refutation_searched))) {
				reject(
					`the refutation rests on a comment or documentation ("${refutation_note}"). Comments and docs are claims ` +
						`under test, not evidence — they can assert a guarantee the code does not keep. Resolve this by tracing ` +
						`the code itself, then record what the code does.`,
				);
			}

			// Version/stdlib behaviour comes from training memory, and memory of
			// version history is unreliable. Make it produce the check or label it.
			if (MEMORY_CLAIM.test(String(claim)) && confidence === "confirmed" && !params.verified_by) {
				reject(
					`"${claim}" is a claim about language or library behaviour, which you are answering from memory. ` +
						`Either run a check and pass the command and its output as verified_by (e.g. python3 -c "..."), read the ` +
						`installed source, or set confidence to "unverified" and drop the severity. ` +
						`Also check what this project actually pins — a version claim is moot if the launcher or manifest pins something else.`,
				);
			}

			if (confidence === "confirmed" && (!Array.isArray(trace) || trace.length < 2)) {
				reject(
					`confidence "confirmed" needs a real trace (at least 2 steps); got ${
						Array.isArray(trace) ? trace.length : 0
					}. Either walk the failing input through the code step by step, or set confidence to "unverified".`,
				);
			}
			if (confidence === "unverified" && severity) {
				reject(`an unverified finding cannot carry a severity. Remove severity, or verify the claim first.`);
			}
			if (confidence === "confirmed" && HEDGE.test(claim)) {
				reject(
					`the claim is hedged ("${claim}") but marked "confirmed". A confirmed finding states what IS wrong. ` +
						`Either state it as fact, or set confidence to "unverified" and drop the severity.`,
				);
			}

			// Mandatory citations create pressure to invent them, so verify the quote is real.
			const absolute = resolveToCwd(String(file), ctx?.cwd ?? process.cwd());
			let contents: string;
			try {
				if (statSync(absolute).isDirectory()) reject(`"${file}" is a directory, not a source file.`);
				contents = readFileSync(absolute, "utf8");
			} catch (err) {
				if (err instanceof Error && err.message.startsWith("report_finding rejected:")) throw err;
				reject(`could not read "${file}" to verify the quote. Cite a file that exists.`);
				return { content: [] };
			}

			const needle = normalize(quote);
			if (needle && !normalize(contents).includes(needle)) {
				reject(
					`the quoted text does not appear in ${file}. Re-read the file and copy the exact source line ` +
						`you are citing — do not reconstruct it from memory.`,
				);
			}

			const lines = contents.split("\n");
			const lineNum = Number(line);
			const located = lines.findIndex((l) => needle && normalize(l) && needle.includes(normalize(l)));
			const lineHint =
				Number.isFinite(lineNum) && located >= 0 && Math.abs(located + 1 - lineNum) > 10
					? ` (note: the quote looks like it is near line ${located + 1}, not ${lineNum})`
					: "";

			reported++;
			if (ctx?.hasUI) {
				ctx.ui.notify(`finding #${reported} recorded: ${claim}`, "info");
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Finding #${reported} recorded (${confidence}, ${provenance})${lineHint}. ` +
							`Continue reviewing, or stop if there is nothing further. ` +
							`Do not repeat this finding in your final message — it is already recorded.`,
					},
				],
				details: { finding: params, index: reported },
			};
		},
	});
}
