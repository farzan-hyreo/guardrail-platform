/**
 * SOT: member-service, invitation-service, seat-count, identity-queries, organization-service
 * WHAT   The only code that reads or writes the organisation, member and invitation tables.
 * WHY    Database isolation inside the service too: handlers hold business rules, this
 *        holds storage. Every signature takes organizationId first, so there is no
 *        function here capable of a cross-tenant query.
 * HOW    organizationId always comes from ctx.orgId, which comes from the signed envelope.
 * WHERE  services/identity/src/index.ts
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "./db";
import { invitation, member, organization, user } from "./schema";

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
    const rows = await db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.organizationId, organizationId));
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

  /** One member row by id, scoped to the org, so a role change cannot reach another tenant. */
  async memberIn(args: { organizationId: string; memberId: string }) {
    const [row] = await db
      .select({ id: member.id, userId: member.userId, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, args.organizationId), eq(member.id, args.memberId)))
      .limit(1);
    return row ?? null;
  },

  /** The caller's own row. `leave` needs this and nothing else - there is no id to pass. */
  async membershipOf(args: { organizationId: string; userId: string }) {
    const [row] = await db
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, args.organizationId), eq(member.userId, args.userId)))
      .limit(1);
    return row ?? null;
  },

  async setMemberRole(args: { organizationId: string; memberId: string; role: string }) {
    const [row] = await db
      .update(member)
      .set({ role: args.role })
      .where(and(eq(member.organizationId, args.organizationId), eq(member.id, args.memberId)))
      .returning({
        id: member.id,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt,
      });
    if (row === undefined) return null;
    const [person] = await db
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, row.userId))
      .limit(1);
    return person === undefined ? null : { ...row, name: person.name, email: person.email };
  },

  /** How many people hold a seat, for the organisation DTO. */
  async organizationWithCount(organizationId: string) {
    const [row] = await db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (row === undefined) return null;
    return { ...row, memberCount: await this.countSeats(organizationId) };
  },

  async slugTaken(slug: string) {
    const [row] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, slug))
      .limit(1);
    return row !== undefined;
  },

  /**
   * Creating an organisation is the one write here that also creates its first member: an
   * organisation with no owner is a tenant nobody can administer, and the two rows have to
   * appear together or not at all.
   */
  async createOrganization(args: {
    name: string;
    slug: string;
    ownerId: string;
    ownerRole: string;
  }) {
    const id = crypto.randomUUID();
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(organization)
        .values({ id, name: args.name, slug: args.slug })
        .returning();
      if (row === undefined) return null;
      await tx.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: id,
        userId: args.ownerId,
        role: args.ownerRole,
      });
      return { ...row, memberCount: 1 };
    });
  },

  async updateOrganization(args: {
    organizationId: string;
    values: { name?: string; slug?: string };
  }) {
    const [row] = await db
      .update(organization)
      .set(args.values)
      .where(eq(organization.id, args.organizationId))
      .returning();
    if (row === undefined) return null;
    return { ...row, memberCount: await this.countSeats(args.organizationId) };
  },

  /**
   * Deleting a tenant deletes what belongs to it. Members and invitations are this
   * service's own tables, so they go in the same transaction; a project row outliving its
   * organisation would be a row no query in the product can ever reach again.
   */
  async deleteOrganization(organizationId: string) {
    return await db.transaction(async (tx) => {
      await tx.delete(invitation).where(eq(invitation.organizationId, organizationId));
      await tx.delete(member).where(eq(member.organizationId, organizationId));
      const [row] = await tx
        .delete(organization)
        .where(eq(organization.id, organizationId))
        .returning({ id: organization.id });
      return row ?? null;
    });
  },
};
