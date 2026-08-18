/**
 * SOT: member-service, invitation-service, seat-count, identity-queries
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "./db";
import { invitation, member, user } from "./schema";

export const identityService = {
  async members(organizationId: string) {
    const rows = await db
      .select({
        id: member.id,
        userId: member.userId,
        name: user.name,
        email: user.email,
        role: member.role,
        createdAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, organizationId))
      .orderBy(desc(member.createdAt));
    return rows;
  },

  async countSeats(organizationId: string) {
    const rows = await db.select({ id: member.id }).from(member).where(eq(member.organizationId, organizationId));
    return rows.length;
  },

  async removeMember(args: { organizationId: string; memberId: string }) {
    const [row] = await db
      .delete(member)
      .where(and(eq(member.organizationId, args.organizationId), eq(member.id, args.memberId)))
      .returning({ id: member.id });
    return row ?? null;
  },

  async invitations(organizationId: string) {
    const items = await db
      .select()
      .from(invitation)
      .where(and(eq(invitation.organizationId, organizationId), eq(invitation.status, "pending")));
    return items;
  },

  async createInvitation(args: {
    organizationId: string;
    email: string;
    role: string;
    inviterId: string;
  }) {
    const [row] = await db
      .insert(invitation)
      .values({
        id: crypto.randomUUID(),
        organizationId: args.organizationId,
        email: args.email,
        role: args.role,
        status: "pending",
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        inviterId: args.inviterId,
      })
      .returning();
    return row ?? null;
  },

  async revokeInvitation(args: { organizationId: string; id: string }) {
    const [row] = await db
      .delete(invitation)
      .where(and(eq(invitation.organizationId, args.organizationId), eq(invitation.id, args.id)))
      .returning({ id: invitation.id });
    return row ?? null;
  },
};
