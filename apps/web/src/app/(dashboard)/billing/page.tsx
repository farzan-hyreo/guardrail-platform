import { PricingTable } from "autumn-js/react";

import { Card, CardContent } from "@guardrail/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@guardrail/ui/table";

import { api } from "@/trpc/server";

export default async function BillingPage() {
  const overview = await api.billing.overview({});

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-muted-foreground">You are on the {overview.entitlements.plan} plan.</p>
      </header>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {overview.resources.map((row) => (
                <TableRow key={row.resource}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{row.usage}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Autumn owns this widget, which is exactly why the layout guard exists. */}
      <PricingTable />
    </div>
  );
}
