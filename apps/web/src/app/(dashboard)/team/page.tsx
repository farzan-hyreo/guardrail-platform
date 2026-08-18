import { Badge } from "@guardrail/ui/badge";
import { Card, CardContent } from "@guardrail/ui/card";

import { api } from "@/trpc/server";

export default async function TeamPage() {
  const { items } = await api.member.list({});
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {items.map((member) => (
              <li key={member.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="font-medium">{member.name}</p>
                  <p className="text-sm text-muted-foreground">{member.email}</p>
                </div>
                <Badge variant="secondary">{member.role}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
