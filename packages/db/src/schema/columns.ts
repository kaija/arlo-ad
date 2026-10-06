import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

// Postgres 18 built-in: time-ordered UUIDs keep B-tree inserts local.
export const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Maintained by Drizzle on update queries; raw SQL updates must set it explicitly.
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
