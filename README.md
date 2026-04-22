# pi-small-model-addons

Tool-level guards and skill prompts for [`pi`](https://github.com/badlogic/pi-mono) (the `@mariozechner/pi-coding-agent` CLI), tuned for driving it with a **small local LLM** instead of a frontier cloud model.

It ports several techniques from Itay Inbar's [_Honey, I Shrunk the Coding Agent_](https://itayinbarr.substack.com/p/honey-i-shrunk-the-coding-agent) paper ([little-coder](https://github.com/itayinbarr/little-coder)) into pi's native extension and skill system. Nothing is forked. Everything is an add-on.

## Is this for you?

**Yes, if you're running `pi` against a small local model** — Qwen3, Llama 3, Phi, Mistral, Gemma, etc., via LM Studio, Ollama, or llama.cpp. Small models are strong enough to drive a coding agent but they fail in characteristic ways: silently overwriting partial work, getting stuck in loops on failing hypotheses, skipping project conventions. These add-ons address those specific failure modes.

**No, if you're running pi against Claude, GPT-4-class models, or Gemini.** Frontier models don't need any of this — you'd just be adding latency and false positives.

## What's in the box

### Extensions (tool-level guards)

| File | What it does |
|------|---|
| `extensions/write-vs-edit-guard.ts` | Blocks the `write` tool on files that already exist and tells the model to use `edit` instead. Also closes the common `bash rm && write` and protected-directory bypasses. |
| `extensions/repetition-loop-abort.ts` | Detects when the model is about to issue the same tool call for the Nth consecutive time (default N=3, tunable via `PI_LOOP_THRESHOLD`) and aborts with a structured reason. |

### Skills (auto-loaded instruction prompts)

| Directory | When it loads |
|------|---|
| `skills/workspace-discovery/` | Before making any code change — directs the model to surface `AGENTS.md`, `CLAUDE.md`, `.docs/instructions.md`, package manifests. |
| `skills/edit-over-write/` | Any time the model is about to modify an existing file — reinforces the edit-over-write rule at the instruction layer so the tool-level guard fires less often. |

Skills and extensions work in tandem. The skill nudges the model toward the right tool; if it tries the wrong one anyway, the extension catches it.

## Install

Requires [`pi`](https://github.com/badlogic/pi-mono) v0.66 or later.

```bash
pi install git:github.com/katlis/pi-small-model-addons
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

## Configuration

### Repetition-loop threshold

Set `PI_LOOP_THRESHOLD` to change how many identical consecutive tool calls are allowed before the abort fires:

```bash
PI_LOOP_THRESHOLD=4 pi
```

Default: `3`. Minimum: `2`. Values below 2 are ignored.

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

### Workspace Discovery skill

Small models often charge into editing without reading the project's own instructions, then produce code that doesn't match the repo's style, test framework, or forbidden-pattern list. The skill instructs the model to run a short discovery pass first — check for `AGENTS.md` / `CLAUDE.md` / `.docs/instructions.md`, walk up to the repo root, read the package manifest — before any code changes.

The skill's `description` frontmatter is written to trigger on common coding-task phrasings ("implement", "modify", "fix", "refactor", mentioning a file path), so pi's progressive-disclosure loader pulls it into context when it's relevant.

### Edit-Over-Write skill

Complements the tool-level guard by reinforcing the rule at the instruction layer: `write` is for new files only, `edit` is for any change to an existing file, and the `edit` tool scales up to whole-file replacements via `old_string` / `new_string`. When the skill is in context, the model is much less likely to reach for `write` in the first place — so the tool-level guard fires less often, and the model's reasoning stays cleaner.

## Credits

- Itay Inbar — [_Honey, I Shrunk the Coding Agent_](https://itayinbarr.substack.com/p/honey-i-shrunk-the-coding-agent) and [little-coder](https://github.com/itayinbarr/little-coder). The Write-vs-Edit invariant, workspace-awareness, and repetition-abort are all direct ports of techniques from that paper.
- Mario Zechner — [pi-mono](https://github.com/badlogic/pi-mono), whose clean extension/skill API made all of this possible without touching the agent internals.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome. If you find a pattern that makes a specific small model fail and could be caught with an extension or a skill prompt, that's exactly the kind of contribution this package is for — please include the model name, the failing transcript, and (if possible) a minimal reproduction.
