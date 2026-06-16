---
name: claim-verification
description: Use whenever you are about to claim that code is buggy, broken, wrong, deprecated, or unsafe, or that a function/parameter/type/flag/API behaves a certain way — during bug hunts, code reviews, audits, security reviews, "is this correct?" questions, or any finding you are about to report to the user. Forces you to open and quote the defining source before asserting, to trace control flow instead of guessing, and to label unverified guesses as guesses rather than facts. Applies any time you would attach a severity, a "this is a bug", or a "you should change X" to code.
---

# Claim Verification

## MANDATORY — verify before you assert

Small models report **plausible-but-wrong** findings: they recall how a library's API *used to* work, or how code *probably* flows, and state it as fact — often with a confident "High severity" label — without ever reading the code that would confirm or refute it. A confident wrong finding is worse than finding nothing: it wastes the user's time and discredits your real findings.

Before you state that any code is buggy, broken, deprecated, or unsafe, or that a symbol behaves a certain way, you MUST have read and quoted the source that proves it. If you have not, you do not have a finding — you have a guess, and you must label it as one.

## Rule: no claim without a quoted source line

1. **Open the definition.** `read` the actual source that defines the thing — the function signature, the class, the config schema, the installed library file. For a local package, the source usually lives in the repo itself (see `workspace-discovery`), not only in `.venv/`, `node_modules/`, or `site-packages/`. If a `find`/`grep` comes back empty, look in the repo root before concluding it doesn't exist.
2. **Quote the line.** Every finding must cite the exact source (`file:line` + the text) that proves it.
3. **If you can't verify, say "unverified".** Never attach a severity (High/Medium/Low) or a "this is a bug" to something you did not confirm against the source.

## Your training memory is not ground truth

The code in front of you wins over your recollection, every time:

- **Library APIs drift.** Parameters get renamed, flags deprecated, defaults changed between versions. If you "know" the parameter is `torch_dtype` (not `dtype`), or `device` (not `device_map`), check anyway — the installed version may be newer or older than what you trained on. Read the installed signature; do not assume it.
- **"This is the wrong way to do X"** requires you to have read how *this* codebase, at *this* version, actually does X. Conventions are project- and version-specific.

## Trace control flow; don't guess it

For any claim about runtime behavior — "this crashes", "this branch is unreachable", "this returns empty", "the loop drops the last element", "this is normalized correctly":

- **Walk a concrete example** through the actual code, line by line, or
- **Run it.** For numeric, loop-count, or edge-case claims, a three-line script or a single command that exercises the path beats arithmetic in your head — silent off-by-one and rounding slips are a classic small-model failure. Prefer an empirical check over a confident assertion.

## Read the whole definition, not a slice

To verify a claim you need the full function or class in view. Read the entire file (or the entire definition) in one `read` call rather than guessing from a fragment or re-reading overlapping line-ranges. Partial views are how "intent vs. implementation" and missing-guard bugs get reported wrongly — and repeated slice-reads also waste context and invite loops.

## Match confidence to evidence

- **Confirmed** — you read and quoted the defining source. Report it as a finding.
- **Unverified / likely** — reasoning only, source not read. Say so explicitly; no severity.
- **"No issues found" is a valid, correct result.** Do not manufacture a finding to look productive. Reporting one real bug with a quote beats listing five speculative ones.
