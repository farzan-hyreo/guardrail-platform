"use client";

import { organization } from "@guardrail/auth/client";
import { Button } from "@guardrail/ui/button";
import { Denial } from "@guardrail/ui/denial";
import { Input } from "@guardrail/ui/input";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { slugify } from "@/features/projects/rules";
import { useTRPC } from "@/trpc/react";

/**
 * A second workspace. The first one is created at signup, so nobody lands here without an
 * organisation any more - this is the path for running more than one.
 *
 * It goes through the gateway rather than `organization.create` on the auth client: that
 * endpoint is refused now (see api/auth/superseded.ts) because it carried no role gate, no
 * rate limit and no plan limit, and left no audit row. Creating is a mutation the block
 * guards; `setActive` is still the auth client's, because it mutates the session and a
 * service never sees one.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const trpc = useTRPC();
  const [name, setName] = useState("");

  const create = useMutation(
    trpc.organization.create.mutationOptions({
      onSuccess: async (created) => {
        await organization.setActive({ organizationId: created.id });
        router.push("/projects");
      },
    }),
  );

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Name your organisation</h1>
      <p className="text-sm text-muted-foreground">
        Projects, plans and teammates all belong to an organisation.
      </p>
      <Input placeholder="Acme" value={name} onChange={(e) => setName(e.target.value)} />
      <Denial error={create.error} resource="organization" />
      <Button
        disabled={name.length < 2 || create.isPending}
        onClick={() => create.mutate({ name, slug: slugify(name) })}
      >
        {create.isPending ? "Creating…" : "Create organisation"}
      </Button>
    </main>
  );
}
