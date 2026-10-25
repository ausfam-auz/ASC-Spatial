import {
  boolean,
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const technicianAccessEventsTable = pgTable(
  "technician_access_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    technicianId: varchar("technician_id")
      .notNull()
      .references(() => usersTable.id),
    changedByUserId: varchar("changed_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    previousIsTechnician: boolean("previous_is_technician").notNull(),
    isTechnician: boolean("is_technician").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("technician_access_events_technician_idx").on(table.technicianId),
    index("technician_access_events_changed_by_idx").on(table.changedByUserId),
  ],
);

export type TechnicianAccessEvent =
  typeof technicianAccessEventsTable.$inferSelect;
