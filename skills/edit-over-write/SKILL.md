---
name: edit-over-write
description: Use whenever you are about to modify an existing file. The write tool is for creating new files only — for any change to an existing file, use the edit tool instead. Applies to fixes, refactors, adding functions, changing imports, editing config, updating docs, or any targeted change to a file that already exists on disk.
---

# Edit Over Write

Small models often reach for the `write` tool when changing an existing file. This silently overwrites everything — including partially-working code you've already built up, and context the file contained. **Do not do this.**

## Rule

- **`write`** — only for **new** files that do not exist yet.
- **`edit`** — for every change to a file that already exists, no matter how large the change.

A file-level guard enforces this at runtime: if you call `write` on an existing path, the call is blocked and you are told to use `edit` instead. Save yourself the round-trip by using `edit` from the start.

## How to edit large sections

The `edit` tool supports any size of replacement. If you need to rewrite most of a function or even most of a file, that is still a job for `edit` — pass the existing text as `old_string` and the new text as `new_string`. Do one `edit` call per logically distinct change; this keeps the diff readable and lets you recover cleanly if one change is wrong.

If `old_string` is not unique in the file, include more surrounding context until it is unique — do not fall back to `write`.

## When `write` is correct

- Creating a new source file, test file, config file, or doc that does not yet exist.
- Writing to a path where you have just confirmed no file exists (e.g. you ran `ls` or `find` and got no hit).

## When you think you need `write` but you don't

- "I want to replace the whole file." → Use `edit` with the full old contents as `old_string`.
- "The file is broken and I want to start over." → Use `edit`. If you cannot construct a working replacement, say so — do not nuke the file.
- "The edit tool is complaining about non-unique matches." → Add more context to `old_string`. Do not escape to `write`.
