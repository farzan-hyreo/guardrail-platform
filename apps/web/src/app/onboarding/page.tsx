"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { organization } from "@guardrail/auth/client";
import { Button } from "@guardrail/ui/button";
import { Input } from "@guardrail/ui/input";

import { slugify } from "@/features/projects/rules";

/** No active organisation means no envelope can be built, so a new user lands here. */
export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  async function create() {
    setPending(true);
    const created = await organization.create({ name, slug: slugify(name) });
    if (created.data) {
      await organization.setActive({ organizationId: created.data.id });
      router.push("/projects");
    }
    setPending(false);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Name your organisation</h1>
      <p className="text-sm text-muted-foreground">
        Projects, plans and teammates all belong to an organisation.
      </p>
      <Input placeholder="Acme" value={name} onChange={(e) => setName(e.target.value)} />
      <Button disabled={name.length < 2 || pending} onClick={create}>
        {pending ? "Creating…" : "Create organisation"}
      </Button>
    </main>
  );
}
