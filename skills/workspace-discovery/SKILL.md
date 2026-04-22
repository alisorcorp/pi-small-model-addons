---
name: workspace-discovery
description: Use whenever the user asks you to implement, modify, fix, refactor, add, or explore code in the current workspace. Surfaces project-specific conventions, setup steps, and constraints from local instruction files (AGENTS.md, CLAUDE.md, README.md, .docs/instructions.md) before any code changes. Also applies when the user mentions "this project", "this repo", or a file path without other context.
---

# Workspace Discovery

Before you write or edit any code, surface local project instructions. Small models often skip this and make stylistic or structural choices that conflict with the repo's conventions.

## Procedure

Run these checks in order. Stop as soon as you have enough to act correctly.

1. **Find instruction files.** From `cwd`, check for these files (in priority order):
   - `AGENTS.md`
   - `CLAUDE.md`
   - `.docs/instructions.md`
   - `.github/copilot-instructions.md`
   - `README.md` (last — lower signal-to-noise for agent directives)

   Use `ls` or `find` to check. If any exist, `read` them.

2. **Walk up for inherited context.** If `cwd` is inside a subdirectory, also check the repo root (usually where `.git/` lives) for the same files. Conventions defined at the root apply to all subdirectories.

3. **Check for a package manifest.** Read whichever of these exist to learn the tech stack and scripts:
   - `package.json` → Node.js; look at `scripts`, `devDependencies`
   - `pyproject.toml` / `requirements.txt` → Python
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `Gemfile` → Ruby

4. **Only after the above**, begin the user's requested work.

## What you are looking for

- **Testing commands** — how does this project run its tests? Don't guess.
- **Lint / format commands** — don't invent `prettier --write`-style commands; use what the project defines.
- **Code style notes** — strict TS vs loose JS, prefer functional vs class components, etc.
- **Forbidden patterns** — e.g. "never use X library", "do not add dependencies without asking".
- **Commit or PR conventions** — if the user asks you to commit.

## When to skip

Skip discovery only if:
- The user's request is a pure question that does not touch files (e.g. "explain this algorithm").
- The user explicitly tells you to skip it ("just do X, don't read docs").
- You have already completed discovery earlier in this same session for the same `cwd`.

## Example

User asks: "Add a /health endpoint to the API."

1. `ls` → see `package.json`, `README.md`, `AGENTS.md`
2. `read AGENTS.md` → learn "routes live in `src/routes/`, register via `fastify.register`, each route gets a test file next to it"
3. `read package.json` → see `"test": "node --test"` and Fastify listed
4. *Now* write the route, following those specific conventions. No guessing.
