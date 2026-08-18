import { buttonVariants } from "@guardrail/ui/button";
import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Guardrail platform</h1>
      <p className="text-muted-foreground">
        A gateway that only routes, services that only answer, and a registry that decides for both.
      </p>
      <div className="flex gap-3">
        <Link href="/projects" className={buttonVariants()}>
          Open the app
        </Link>
        <Link
          className="inline-flex h-9 items-center rounded-md border border-input px-4 text-sm"
          href="/sign-in"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
