# pi-small-model-addons

Tool-level guards and skill prompts for [`pi`](https://github.com/badlogic/pi-mono) (the `@earendil-works/pi-coding-agent` CLI, formerly `@mariozechner/…`), tuned for driving it with a **small local LLM** instead of a frontier cloud model.

It ports several techniques from Itay Inbar's [_Honey, I Shrunk the Coding Agent_](https://itayinbarr.substack.com/p/honey-i-shrunk-the-coding-agent) paper ([little-coder](https://github.com/itayinbarr/little-coder)) into pi's native extension and skill system. Nothing is forked. Everything is an add-on.

## Is this for you?

**Yes, if you're running `pi` against a small local model** — Qwen3, Llama 3, Phi, Mistral, Gemma, etc., via LM Studio, Ollama, or llama.cpp. Small models are strong enough to drive a coding agent but they fail in characteristic ways: silently overwriting partial work, getting stuck in loops on failing hypotheses, skipping project conventions, and confidently reporting unverified guesses as facts. These add-ons address those specific failure modes.

**No, if you're running pi against Claude, GPT-4-class models, or Gemini.** Frontier models don't need any of this — you'd just be adding latency and false positives.

## What's in the box

### Extensions (tool-level guards)

| File | What it does |
|------|---|
| `extensions/write-vs-edit-guard.ts` | Blocks the `write` tool on files that already exist and tells the model to use `edit` instead. Also closes the common `bash rm && write` and protected-directory bypasses. |
| `extensions/repetition-loop-abort.ts` | Detects when the model is about to issue the same tool call for the Nth consecutive time (default N=3, tunable via `PI_LOOP_THRESHOLD`) and aborts with a structured reason. |
| `extensions/read-dir-redirect.ts` | Turns the raw `EISDIR` error from calling `read` on a directory into the directory listing the model was after, so it gets the answer in the same turn instead of spending one on recovery. |
| `extensions/report-finding.ts` | Registers a `report_finding` tool whose schema makes the trace, the refutation attempt, and the confidence label mandatory, so an unverified finding is rejected by the runtime rather than by the model's own discipline. Persists refuted claims across sessions. |

### Skills (auto-loaded instruction prompts)

| Directory | When it loads |
|------|---|
| `skills/workspace-discovery/` | Before making any code change — directs the model to surface `AGENTS.md`, `CLAUDE.md`, `.docs/instructions.md`, package manifests. |
| `skills/edit-over-write/` | Any time the model is about to modify an existing file — reinforces the edit-over-write rule at the instruction layer so the tool-level guard fires less often. |
| `skills/claim-verification/` | Before reporting any finding (bug hunt, code review, audit) — requires quoting the defining source line before asserting code is wrong, tracing control flow instead of guessing, and labelling unverified guesses as guesses. |

Skills and extensions work in tandem. The skill nudges the model toward the right tool; if it tries the wrong one anyway, the extension catches it.

## Install

Requires [`pi`](https://github.com/badlogic/pi-mono) **v0.68 or later** — `report-finding` needs the `before_agent_start` system-prompt return added in 0.68.0. Developed and tested against 0.84.x.

```bash
pi install git:github.com/alisorcorp/pi-small-model-addons
```

That's it. Extensions load automatically on next `pi` launch. Skills are available via their descriptions (auto-loaded on matching tasks) or explicitly as `/skill:workspace-discovery` / `/skill:edit-over-write`.

Update later with:

```bash
pi update pi-small-model-addons
```

Uninstall with:

```bash
pi remove pi-small-model-addons
```

## Testing

```bash
npm test
```

Runs the extension logic directly under Node's type stripping — no build step, no dependencies, no pi instance and no model required. Covers the guard behaviour, the schema enforcement, path resolution (`~`, `@`, `file://`, relative), and the claim-memory round trip.

## Configuration

### Repetition-loop threshold

Set `PI_LOOP_THRESHOLD` to change how many identical consecutive tool calls are allowed before the abort fires:

```bash
PI_LOOP_THRESHOLD=4 pi
```

Default: `3`. Minimum: `2`. Values below 2 are ignored.

### Claim memory location

Refuted claims are persisted to `~/.pi/agent/claim-memory.json` and re-injected at the start of each session. Override the path with `PI_CLAIM_MEMORY`:

```bash
PI_CLAIM_MEMORY=/path/to/claim-memory.json pi
```

Delete the file to forget everything; edit it by hand to seed a refutation you already know.

### Directory listing size

Set `PI_READ_DIR_LIMIT` to change how many entries a redirected directory read returns before truncating:

```bash
PI_READ_DIR_LIMIT=50 pi
```

Default: `200`. Minimum: `1`. Non-numeric and out-of-range values fall back to the default. Lower it if listings of large directories are crowding a small context window.

### Disabling individual pieces

Use `pi config` (interactive TUI) to toggle individual extensions or skills without uninstalling the whole package.

## How each piece works

### Write-vs-Edit Guard

When the model calls `write`, the extension intercepts the `tool_call` event and checks:

1. Is the target path inside `.git/` or `node_modules/`? → block
2. Was the target path deleted via `bash` earlier in this session? → block (closes the `rm && write` bypass)
3. Does the target path already exist on disk? → block with an explanation that directs the model to `edit` instead

All blocks return a structured `reason` that the model sees as a tool result, containing a concrete "use edit with these arguments" recipe. In practice this causes small models to pivot to `edit` on the very next turn.

**Known limitation:** a user who explicitly tells the model to use `write` on an existing file can fall through to a shell redirect (`echo > file`) via the general-purpose `bash` tool. This isn't filtered — filtering bash redirects produces too many false positives against legitimate shell work. The guard's job is to prevent _accidental_ clobbering during exploration, not to lock files against an instructed overwrite.

### Repetition-Loop Abort

On every `tool_call`, the extension walks the current session branch, collects every prior tool call's `(name, stable-stringified-arguments)` hash, and counts how many of the most recent calls match the incoming call (streak from the tail). If the streak is `≥ PI_LOOP_THRESHOLD`, the call is blocked with a reason telling the model to change approach.

"Consecutive" matters more than "N of M" — interleaved unrelated calls reset the streak. This avoids false positives when the model legitimately re-reads a file after unrelated work.

Argument comparison uses a stable stringifier (sorted keys, recursive) so key ordering differences don't mask identical calls.

### Read-Directory Redirect

pi's `read` tool has no directory guard, so pointing it at a directory surfaces the raw syscall error: `EISDIR: illegal operation on a directory, read`. Small models do this constantly — reaching for `read` on a directory is the natural first move when orienting in an unfamiliar project — and an errno teaches them nothing, so they spend the next turn recovering with `ls` or a `bash ls -la`. On a slow local model that recovery round trip costs minutes of wall-clock for information that was already available.

This extension repairs the result rather than punishing the call. On `tool_result` for `read`, if the target resolves to a directory, the failed result is replaced with an alphabetical listing (dotfiles included, `/` suffix on directories, matching pi's own `ls` output) and marked as a success. The replacement text leads with the fact that `read` does not apply to directories and points at `ls` for next time, so the correction still lands — it just doesn't cost a turn.

It is deliberately **not** a `tool_call` block like the write guard. pi converts a blocked call into an error tool result, which is the wrong signal here: reading a directory is a harmless mistake, not a dangerous one, and the model had already told you exactly what it wanted.

Paths are resolved the way pi resolves them — `~` expansion, `@` prefix stripping, unicode space normalisation, `file://` URLs, and relative paths against the session cwd — so tilde and relative arguments are matched rather than silently missed. Listings are capped (see `PI_READ_DIR_LIMIT`) so a stray `read` on `node_modules/` cannot flood a small context window. Reads of regular files, missing paths, and unreadable directories are left untouched, so pi's own error messages still surface unchanged.

### Report-Finding tool

> **Status: experimental.** The three pieces above port techniques with a track record. This one and the claim memory were developed against a *single* model (a 30B dense local model) over several review rounds on *one* codebase. Across those rounds its false-positive rate fell from four confident falsehoods to one, then to zero — but recall did not improve, and it has not yet been run against a repository with a known planted bug. So there is good evidence it suppresses bad claims and **no evidence yet that it preserves good ones**. If you install it, treat a quiet review as unproven rather than clean, and please open an issue with your model and transcript either way.


The `claim-verification` skill asks for a traced failure scenario and a failed refutation per finding. Small models read that as a **posture** rather than a procedure: they adopt the vocabulary ("given the claim-verification skill, we should verify claims"), hedge the conclusion, and ship untraced "potential issues" anyway. This was observed directly — a model ran roughly twenty refute-the-hypothesis cycles internally, correctly killed most of them, then reported the survivors in prose with no trace, no citation and no confidence label, at the same apparent confidence as the ones it had actually checked. The thinking was better than the output, and everything was lost at the joint between them.

Instruction cannot close that joint, because the model believes it is already complying. A schema can. `report_finding` makes the fields mandatory arguments, so pi's own argument validation rejects an incomplete finding before it ever executes. The guidelines are registered via `promptGuidelines`, which lands in the system prompt rather than in progressively-disclosed skill text — a stronger channel for a model that treats skills as optional.

Because mandatory fields create pressure to fabricate them, the mechanically checkable ones are checked. The quoted source must actually appear in the cited file. A finding whose own refutation pass found a defeating mechanism is rejected as disproved — and recorded, so it does not come back. A refutation resting on "the comment says it's fine" is rejected, because comments are claims under test. A claim about language or library behaviour must carry the command you ran, or be labelled unverified. `confirmed` requires a real multi-step trace, and an unverified finding cannot carry a severity.

Refuted claims are written to `~/.pi/agent/claim-memory.json` and injected into the system prompt on the next session. This exists because corrections do not survive a session boundary: the same false version claim, corrected and accepted in one session, came back in the next — and it came back as a *question* the model then answered wrongly from memory. Answering it up front is the only thing that breaks that loop.

### Workspace Discovery skill

Small models often charge into editing without reading the project's own instructions, then produce code that doesn't match the repo's style, test framework, or forbidden-pattern list. The skill instructs the model to run a short discovery pass first — check for `AGENTS.md` / `CLAUDE.md` / `.docs/instructions.md`, walk up to the repo root, read the package manifest — before any code changes.

The skill's `description` frontmatter is written to trigger on common coding-task phrasings ("implement", "modify", "fix", "refactor", mentioning a file path), so pi's progressive-disclosure loader pulls it into context when it's relevant.

### Edit-Over-Write skill

Complements the tool-level guard by reinforcing the rule at the instruction layer: `write` is for new files only, `edit` is for any change to an existing file, and the `edit` tool scales up to whole-file replacements via `old_string` / `new_string`. When the skill is in context, the model is much less likely to reach for `write` in the first place — so the tool-level guard fires less often, and the model's reasoning stays cleaner.

### Claim-Verification skill

Small models report **plausible-but-wrong** findings during reviews and bug hunts: they recall how a library's API *used to* work, or how code *probably* flows, and state it as fact — often with a confident "High severity" label — without reading the code that would confirm or refute it. Stale training knowledge (renamed parameters, deprecated flags, changed defaults) gets asserted as current truth; control-flow conclusions ("this crashes first", "this branch is unreachable") get asserted without tracing the actual values. A confident wrong finding is worse than no finding — it wastes the user's time and discredits the model's real findings.

The skill imposes a "no claim without a quoted source line" discipline: open and `read` the defining source before asserting anything is wrong, cite the exact `file:line` that proves it, trace a concrete example (or just run it) for runtime/numeric claims, read the whole definition rather than a slice, and explicitly label anything unverified as a guess — never attaching a severity to it. "No issues found" is reinforced as a valid result, so the model doesn't manufacture findings to look productive.

Its `description` frontmatter triggers on review/audit/bug-hunt phrasings and on the act of reporting a finding, so the loader pulls it into context exactly when the model is about to make a claim. It pairs naturally with Workspace Discovery (which makes the model read the project's own conventions first) — together they cover the "find the real source, then verify against it" loop.

## Credits

- Itay Inbar — [_Honey, I Shrunk the Coding Agent_](https://itayinbarr.substack.com/p/honey-i-shrunk-the-coding-agent) and [little-coder](https://github.com/itayinbarr/little-coder). The Write-vs-Edit invariant, workspace-awareness, and repetition-abort are all direct ports of techniques from that paper.
- Mario Zechner — [pi-mono](https://github.com/badlogic/pi-mono), whose clean extension/skill API made all of this possible without touching the agent internals.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome. If you find a pattern that makes a specific small model fail and could be caught with an extension or a skill prompt, that's exactly the kind of contribution this package is for — please include the model name, the failing transcript, and (if possible) a minimal reproduction.
