import { Card, CardContent } from "@guardrail/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@guardrail/ui/table";

import { api } from "@/trpc/server";

/**
 * Free-plan organisations never reach this page: auditLog is not in their plan, so the
 * dashboard layout redirects them to billing first. Nothing here checks for that.
 */
export default async function AuditPage() {
  const { items } = await api.audit.list({ limit: 50 });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    {entry.resource}.{entry.operation}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{entry.actorRole}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {entry.createdAt.toISOString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
