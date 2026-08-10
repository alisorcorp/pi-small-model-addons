---
name: claim-verification
description: Use whenever you are about to claim that code is buggy, broken, wrong, deprecated, or unsafe, or that a function/parameter/type/flag/API behaves a certain way — during bug hunts, code reviews, audits, security reviews, "is this correct?" questions, or any finding you are about to report to the user. Forces every finding to carry a traced failure scenario and a failed refutation attempt before it can be reported, and to label unverified guesses as guesses rather than facts. Applies any time you would attach a severity, a "this is a bug", or a "you should change X" to code.
---

# Claim Verification

## The mistake you are actually going to make

You will not invent a bug out of nothing. You will report a **plausible neighbour of something real**: a genuine quirk sitting two lines away from the thing you flagged, a real dependency you garbled, a library behaviour that was true in some other version. It will feel like you are reading the code, because you *are* reading the code — you are just not deriving your conclusion from it.

So "only report what's in the code" is not a rule you can follow. You already believe you are following it. What follows is structural instead: work you must **produce**, not discipline you must remember.

Quoting the source does not protect you. It is possible — common — to quote the exact line that disproves your claim and assert the claim anyway. The check happens *after* the quote is in hand, and that is the step that gets skipped.

## Every finding must carry these fields

A finding with a missing field is not a finding. Do not report it. Say "no issues found" instead.

1. **Claim** — one sentence. What is wrong.
2. **Evidence** — `file:line` plus the quoted lines.
3. **Failing input or state** — a concrete one. "A meeting starting in 90 seconds while `dismissed_until` is unset", not "certain conditions".
4. **Trace** — walk that input through the quoted code, step by step, to the wrong output. Name the value at each step. If you cannot produce the walk, you do not understand the path well enough to report it.
5. **Refutation attempt** — see below. What would stop this bug, where you looked for it, and why it does not apply.
6. **Provenance** — `new` if you derived it from the code, `restated` if the repo's own docs, comments, `CLAUDE.md`, or `AGENTS.md` already say it. Restating documented behaviour as a discovery inflates your apparent hit rate and wastes the reader's attention.
7. **Confidence** — `confirmed` (you produced fields 2–5) or `unverified` (you did not). Never attach a severity to an `unverified` item.

## The refutation pass — the highest-value step

Before reporting, spend one pass trying to **kill your own finding**. Ask: *what mechanism in this codebase would prevent this failure?* Then go look for it.

Look for a guard clause or early return above the line you quoted. A `None`/`nil`/type check. A signal handler, event set, or wake call below it. A caller that filters the input before it ever arrives. A default that makes the branch unreachable. A version pin that settles a library question.

Search a few lines **either side** of your quoted code before anything else. That is where the refutation usually lives — a guard immediately above the call you flagged, an event fired immediately below the flag you flagged.

Read the whole function, not the slice you already have. Partial views are how missing-guard bugs get reported wrongly.

If you find the mechanism, **the finding is dead — drop it.** Do not soften it into a hedge and report it anyway. If you find nothing, say where you looked; that sentence is what makes the finding trustworthy.

## Watch for self-contradiction

If a sentence in your own write-up states a fact that undercuts your conclusion, the conclusion is wrong — not the fact. Writing "the handler wakes the loop" and then "so the worst case is a full poll interval" is a contradiction inside one sentence, and it is a signal you have stopped deriving and started pattern-matching. Reread your own paragraph before you ship it.

## Version and library claims need a check, not a memory

Any claim about what a language version, stdlib function, or library API does — "this fails before 3.11", "this parameter was renamed", "this flag is deprecated" — is a **memory** claim, and your memory of version history is unreliable.

Check it or label it `unverified`: read the installed source or signature, look it up, or run a one-line interpreter test. Also check what the project actually pins — a version claim is moot if the launcher, lockfile, or manifest pins something else entirely.

## "No issues found" is a correct result

Do not manufacture findings to look productive. One finding with a real trace and a failed refutation is worth more than five hedged observations, and far more than one confident falsehood — a wrong finding costs the reader a full code-reading round trip to disprove, which is the whole cost you were supposed to be saving them.
