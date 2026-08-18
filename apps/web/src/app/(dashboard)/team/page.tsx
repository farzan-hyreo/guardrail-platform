import { MemberList } from "@/features/team/member-list";
import { api } from "@/trpc/server";

export default async function TeamPage() {
  // Server component -> gateway block -> NATS -> identity service. Same path as the browser.
  const result = await api.member.list({});
  // A command answers with a receipt instead of rows; only the query shape has members.
  return <MemberList initialItems={"items" in result ? result.items : []} />;
}
