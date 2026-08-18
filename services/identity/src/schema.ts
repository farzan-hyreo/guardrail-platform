/**
 * SOT: identity-schema, member-table, invitation-table, organization-table
 * WHAT   The organisation, member and invitation tables.
 * WHY    Better Auth writes these from the gateway; this service reads them and owns the
 *        migrations. That split is a deliberate trade-off, documented in the README: it
 *        keeps Better Auth's write logic (hooks, expiry, acceptance) intact while still
 *        giving the identity service ownership of the data and its queries.
 * NOTE   Regenerate with `pnpm auth:generate` in @guardrail/auth and copy changes here.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  image: text("image"),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id").notNull(),
});
