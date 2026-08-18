/**
 * SOT: member-list-ui, invite-member-ui, remove-member-ui
 * WHAT   The team roster, plus the two controls the registry already declared for it:
 *        invite (member:create) and remove (member:delete).
 * WHY    Both permissions existed as gateway routes, subjects and audit events with
 *        nothing in the UI able to reach them. Which control a person sees is decided by
 *        the same registry rules the gateway will apply to the call itself.
 * HOW    AccessGate hides what the role may not do; PriceGate turns a spent seat
 *        allowance into the registry's own upsell instead of a request bound to fail.
 * WHERE  apps/web/src/app/(dashboard)/team/page.tsx
 */
"use client";

import type { OutputOf } from "@guardrail/contracts";
import { assignableRoles, normalizeRole, type OrgRole } from "@guardrail/registry";
import { AccessGate } from "@guardrail/ui/access-gate";
import { Badge } from "@guardrail/ui/badge";
import { Button } from "@guardrail/ui/button";
import { Card, CardContent } from "@guardrail/ui/card";
import { Input } from "@guardrail/ui/input";
import { PriceGate, useUsageLabel } from "@guardrail/ui/price-gate";
import { useViewer } from "@guardrail/ui/viewer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useTRPC } from "@/trpc/react";

type Member = OutputOf<"member", "read">["items"][number];

export function MemberList({ initialItems }: { initialItems: Member[] }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { role: viewerRole } = useViewer();
  // Roles this viewer may grant - never above their own. member -> [member],
  // admin -> [member, admin], owner -> all three.
  const grantableRoles = assignableRoles(viewerRole);
  const [email, setEmail] = useState("");
  // The least privileged role the registry recognises - what an unknown role degrades to.
  const [role, setRole] = useState<OrgRole>(normalizeRole(null));

  const members = useQuery(
    trpc.member.list.queryOptions({}, { initialData: { items: initialItems } }),
  );

  const invite = useMutation(
    trpc.member.invite.mutationOptions({
      onSuccess: () => {
        setEmail("");
        void queryClient.invalidateQueries({ queryKey: trpc.member.list.queryKey() });
      },
    }),
  );

  const remove = useMutation(
    trpc.member.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.member.list.queryKey() });
      },
    }),
  );

  const seats = useUsageLabel("member");

  // The gateway answers a query with its output or a command with a receipt. Only the
  // first shape carries rows; initialData covers the paint before the query settles.
  const data = members.data;
  const rows = data !== undefined && "items" in data ? data.items : initialItems;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Team</h1>
          <p className="text-sm text-muted-foreground">Seats {seats}</p>
        </div>
        <AccessGate resource="member" operation="create">
          <PriceGate resource="member">
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="name@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-56"
              />
              <select
                aria-label="Role"
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={role}
                onChange={(event) => setRole(normalizeRole(event.target.value))}
              >
                {grantableRoles.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <Button
                disabled={email.trim().length === 0 || invite.isPending}
                onClick={() => invite.mutate({ email: email.trim(), role })}
              >
                {invite.isPending ? "Inviting…" : "Invite"}
              </Button>
            </div>
          </PriceGate>
        </AccessGate>
      </header>

      {invite.error ? <p className="text-sm text-destructive">{invite.error.message}</p> : null}
      {remove.error ? <p className="text-sm text-destructive">{remove.error.message}</p> : null}

      {/* create is a command, not an rpc: the seat appears once identity has executed it. */}
      {invite.isSuccess ? (
        <p className="text-sm text-muted-foreground">Invitation accepted. It sends shortly.</p>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {rows.map((member) => (
              <li key={member.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="font-medium">{member.name}</p>
                  <p className="text-sm text-muted-foreground">{member.email}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="secondary">{member.role}</Badge>
                  <AccessGate resource="member" operation="delete">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate({ memberId: member.id })}
                    >
                      Remove
                    </Button>
                  </AccessGate>
                </div>
              </li>
            ))}
            {rows.length === 0 ? (
              <li className="px-4 py-10 text-center text-muted-foreground">
                No one here yet. Invite the first teammate.
              </li>
            ) : null}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
