"use client";

/**
 * SOT: dashboard-error-boundary, segment-error, error-recovery
 * WHAT   The segment boundary for every page under (dashboard).
 * WHY    Each page awaits a blocking server call in its component body - `api.project.list`,
 *        `api.billing.overview` - which reaches the gateway, the bus and a service. Any of
 *        those being unavailable throws during render, and without a boundary React unmounts
 *        the whole tree and Next.js serves a bare 500 with no navigation on it. A denial the
 *        platform has a vocabulary for (SERVICE_UNAVAILABLE, DEADLINE_EXCEEDED) should not
 *        look like a crash.
 * HOW    It sits inside (dashboard)/layout.tsx, so the sidebar, the viewer context and the
 *        route guard all survive: only the page area is replaced, and `reset()` re-renders
 *        it without a full navigation. A throw in the LAYOUT itself is above this boundary
 *        and is caught by app/global-error.tsx instead - the two are not interchangeable.
 * HOW    The message is deliberately not read off `error.message`. React replaces a server
 *        error with a generic one in production and keeps only `digest`, so anything parsed
 *        out of it here would be a string that exists in development and not in production.
 *        The digest is shown because it is the only thing that correlates this screen with
 *        the server log line.
 * WHERE  apps/web/src/app/global-error.tsx, apps/web/src/gateway/init.ts
 */
import { Button } from "@guardrail/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-4 py-16" role="alert">
      <h1 className="text-xl font-semibold">This page could not load</h1>
      <p className="text-sm text-muted-foreground">
        Something behind this screen did not answer. Your data is unaffected - nothing was written.
        Try again, and if it keeps happening the reference below identifies the request in our logs.
      </p>
      {error.digest === undefined ? null : (
        <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
      )}
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
