/**
 * SOT: project-list-ui, optimistic-projects, project-create-form
 * WHAT   Project list with optimistic create.
 * WHY    Both halves of the mirror in one file: <Gate> decides whether the control exists,
 *        and <UpgradePrompt> renders the platform's own denial if the plan is the blocker.
 */
"use client";

import type { OutputOf } from "@guardrail/contracts";
import { Button } from "@guardrail/ui/button";
import { Card, CardContent } from "@guardrail/ui/card";
import { Denial } from "@guardrail/ui/denial";
import { Gate, useAccess } from "@guardrail/ui/gate";
import { Input } from "@guardrail/ui/input";
import { UpgradePrompt } from "@guardrail/ui/upgrade-prompt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { slugify } from "@/features/projects/rules";
import { useTRPC } from "@/trpc/react";

type Project = OutputOf<"project", "read">["items"][number];

export function ProjectList({ initialItems }: { initialItems: Project[] }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const projects = useQuery(
    trpc.project.list.queryOptions(
      { limit: 20, includeArchived: false },
      { initialData: { items: initialItems, nextCursor: null } },
    ),
  );

  const create = useMutation(
    trpc.project.create.mutationOptions({
      onSuccess: () => {
        setName("");
        void queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() });
      },
    }),
  );

  const access = useAccess("project", "create");

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <Gate
          resource="project"
          operation="create"
          fallback={access.decision.allowed ? null : <UpgradePrompt decision={access.decision} />}
        >
          <div className="flex gap-2">
            <Input
              placeholder="New project name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-56"
            />
            <Button
              disabled={name.length < 2 || create.isPending}
              onClick={() => create.mutate({ name, slug: slugify(name) })}
            >
              {create.isPending ? "Creating…" : "Create project"}
            </Button>
          </div>
        </Gate>
      </header>

      <Denial error={create.error} resource="project" />

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {projects.data.items.map((project) => (
              <li key={project.id} className="px-4 py-3">
                <p className="font-medium">{project.name}</p>
                <p className="text-sm text-muted-foreground">/{project.slug}</p>
              </li>
            ))}
            {projects.data.items.length === 0 ? (
              <li className="px-4 py-10 text-center text-muted-foreground">
                No projects yet. Create the first one.
              </li>
            ) : null}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
