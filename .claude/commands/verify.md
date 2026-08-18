---
description: Typecheck, lint, and report anything that violates the architecture
---
Run `pnpm verify` and fix everything it reports.

Then audit the diff against these, and report violations rather than fixing silently:
org id read from input, business logic in a gateway router, a raw subject string, a
database import outside a service, a hand-written type that could be derived, a new page
outside the dashboard layout's route guard.
