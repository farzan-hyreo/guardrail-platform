---
description: Scaffold a new feature end to end, in prerequisite order
---
Add a new feature to the platform: $ARGUMENTS

Use the `add-feature` skill and follow its order exactly: registry entry first, then let
`pnpm typecheck` tell you what is missing at each step. Do not write any file before the
registry entry exists. Finish with `pnpm verify` and report what the new subjects are.
