---
name: context-discipline
description: Use when looking for where something lives in the codebase, before opening files to orient yourself, and when writing comments or documentation in a new file. Covers the SOT header convention, grep-first navigation and why there is no docs folder.
---

# Finding things and writing comments

Covers: inline injection (1:51:51), grep-first (1:57:00).

## Find before you read

```bash
pnpm sot permissions      # → the file that OWNS that concept
pnpm sot the-block
pnpm sot:map              # → every concept in the repo
```

`grep -l` returns paths, not contents. Locating a concept costs a few tokens instead of a
few thousand. **Never read a directory to orient yourself, and never open a file to find
out whether it is the right file.**

If `pnpm sot` finds nothing, the concept has no owner yet - that is useful information, and
usually means you are about to create one. Give it a `SOT:` header when you do.

## The SOT header

Every file opens with one:

```ts
/**
 * SOT: entitlements, feature-gate, plan-limits, client-mirror
 * WHAT   The one function that decides whether a plan may use a resource right now.
 * WHY    Server and client must never disagree about a limit.
 * HOW    No IO. Feed it a plan and a usage snapshot.
 * WHERE  guardrail/gateway.ts, ui/gate.tsx
 */
```

- `SOT:` - concepts this file **owns**. Include the words someone would actually search
  for, including near-synonyms. Two files should rarely claim the same concept; if they do,
  one of them is wrong.
- `WHAT` - one line, what it is.
- `WHY` - the decision behind it. This is the line that stops someone undoing it in six
  months. Write the reason, not the restatement.
- `HOW` - how to use or extend it, when non-obvious.
- `WHERE` - who consumes it. This is the cheap version of a dependency graph.

Comment at the top of a file and above a non-obvious block. Not every line.

## Why there is no docs/ folder

Documentation drifts silently, and loading it costs the whole file. Comments sit next to
the code they describe, so a change that invalidates one is visible in the same diff.

If you find yourself writing a design document, write it as a `WHY` on the file instead.

## Never

- A `docs/` or `architecture.md` describing how the code works. The code says that.
- Restating a type in a comment.
- Opening more than two or three files before running `pnpm sot`.
