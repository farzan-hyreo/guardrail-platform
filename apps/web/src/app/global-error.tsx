"use client";

/**
 * SOT: global-error-boundary, root-error, layout-throw
 * WHAT   The last boundary. Catches what no segment boundary can.
 * WHY    (dashboard)/layout.tsx does real work before it renders anything: it calls
 *        `identify`, then `gatewayDeps.entitlements`, which is an rpc call over the bus. A
 *        throw there happens ABOVE (dashboard)/error.tsx, so that boundary never runs and
 *        the user gets Next.js's built-in 500 - the one screen in the product nobody wrote.
 *        The root layout can throw for the same reason, and this is the only boundary above
 *        it.
 * HOW    A global boundary replaces the root layout, so it has to render its own <html> and
 *        <body> - React is not rendering the ones in app/layout.tsx any more. It therefore
 *        cannot use the sidebar, the viewer context or anything that depends on them, and
 *        it deliberately imports nothing from the gateway: this is the screen that renders
 *        when the layer underneath is what failed. Styling is inline for the same reason -
 *        it must not depend on globals.css having loaded.
 * WHERE  apps/web/src/app/(dashboard)/error.tsx
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          display: "flex",
          minHeight: "100dvh",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <main role="alert" style={{ maxWidth: "28rem" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 0.75rem" }}>
            Guardrail is temporarily unavailable
          </h1>
          <p style={{ fontSize: "0.875rem", lineHeight: 1.6, margin: "0 0 1rem", opacity: 0.75 }}>
            We could not load the application shell. This is on our side, not yours, and nothing you
            were doing has been lost.
          </p>
          {error.digest === undefined ? null : (
            <p
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                margin: "0 0 1rem",
                opacity: 0.6,
              }}
            >
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              font: "inherit",
              fontSize: "0.875rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
