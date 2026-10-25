import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const scanModuleTypeEnum = pgEnum("scan_module_type", [
  "DeckOps",
  "ToolingAudit",
]);

export const scanMetadataTable = pgTable("scan_metadata", {
  id: uuid("id").defaultRandom().primaryKey(),
  moduleType: scanModuleTypeEnum("module_type").notNull(),
  technicianId: text("technician_id").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  vesselAssetName: text("vessel_asset_name").notNull(),
  storageUrl: text("storage_url").notNull(),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull(),
  uploadedBy: varchar("uploaded_by")
    .notNull()
    .references(() => usersTable.id),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const scanUploadRateLimitsTable = pgTable("scan_upload_rate_limits", {
  technicianId: varchar("technician_id")
    .primaryKey()
    .references(() => usersTable.id),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  requestCount: integer("request_count").notNull().default(0),
});

export type ScanMetadata = typeof scanMetadataTable.$inferSelect;
