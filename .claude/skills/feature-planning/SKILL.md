---
name: feature-planning
description: Use before building anything large or multi-part, when a request would touch several services or layers, or when a change is not landing and you need a way to find out what is really there. Covers prerequisite ordering, deliberate gaps and assumption-first prompting.
---

# Planning a feature

Covers: how to prompt (2:20:29), red-green prompting (2:38:32).

## Order by prerequisite, not by intuition

List the parts, then number them so nothing is built before what it depends on. The
intuitive order is usually wrong: for a website builder, "canvas" feels first, but the
element the canvas has to render must exist before the canvas can be tested at all.

For this platform the order is fixed and mechanical - `registry → contract → service →
gateway route → UI` - because each step's compile errors define the next step's work.
Follow it even when the feature seems small.

## Split, then iterate

One coherent thing per pass. "Invite a teammate" is two things: creating the invitation, and
delivering the email. Building both at once buries a reusable delivery path inside a feature
that happens to need it first.

Leave the second half as a **deliberate gap**, and make the gap loud enough to find:

- `throw new ServiceError("INTERNAL", "TODO: delivery not wired")` - impossible to miss.
- A failing test, or a `console.warn` in a dev-only branch.

Never leave a silent TODO comment. A gap you have to remember is a gap you will ship.

## Assume it exists

Your opening assumption decides the first thing that happens. "Build X" makes the model
write. "We already have a source of truth for X somewhere - find it and use it" makes it
search first, which is almost always the better first move in a codebase this derived.

```
We already have a source of truth for payments somewhere in this platform.
Use it, and wire invoices into it. Do not create a second one.
```

There is no downside: if it does not exist, you get told, and you have just learned that
the thing you assumed should exist probably should.

The same move works for debugging. Stating a suspicion as a fact makes the model verify
rather than agree:

```
There are two competing implementations of the editor wired together.
First verify that claim, then remove every reference to the old one.
```

Ask it to verify the claim, not to act on it - so a false claim is corrected instead of
being built on.

## Before you start

- Does this need a new service, or does it belong to an existing one? (`jetstream-service`)
- Which resources does it add? (`add-feature`)
- Does anything cross a service boundary? If two services need to write the same table, the
  boundary is wrong - stop and say so rather than sharing a schema.
