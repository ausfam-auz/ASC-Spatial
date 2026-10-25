import { getAuth } from "@clerk/express";
import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  GetTechnicianAccessHistoryResponse,
  ListTechniciansResponse,
  UpdateTechnicianAccessBody,
  UpdateTechnicianAccessResponse,
} from "@workspace/api-zod";
import {
  db,
  technicianAccessEventsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { isWorkspaceAdmin, requireAdmin } from "../middlewares/requireAdmin";

const router = Router();
const changedByUserTable = alias(usersTable, "access_event_changed_by");

router.get("/me", requireAuth, (req, res) => {
  const claims = getAuth(req).sessionClaims;
  const text = (value: unknown) => typeof value === "string" ? value : null;
  res.json({ user: {
    id: req.dbUser!.id,
    isTechnician: req.dbUser!.isTechnician,
    email: text(claims?.email),
    firstName: text(claims?.firstName),
    lastName: text(claims?.lastName),
    profileImageUrl: null,
    isAdmin: isWorkspaceAdmin(text(claims?.email)),
  } });
});

router.get("/admin/technicians", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const accounts = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        isTechnician: usersTable.isTechnician,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .orderBy(asc(usersTable.createdAt));
    res.json(ListTechniciansResponse.parse({ accounts }));
  } catch (error) {
    _req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Failed to load technician review accounts",
    );
    res.status(503).json({ error: "Technician accounts are temporarily unavailable" });
  }
});

router.get(
  "/admin/technicians/:userId/access-history",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const technicianId = req.params.userId;
    if (typeof technicianId !== "string") {
      res.status(400).json({ error: "Invalid workspace account ID" });
      return;
    }

    try {
      const [technician] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.id, technicianId))
        .limit(1);
      if (!technician) {
        res.status(404).json({ error: "Workspace account not found" });
        return;
      }

      const events = await db
        .select({
          id: technicianAccessEventsTable.id,
          previousIsTechnician:
            technicianAccessEventsTable.previousIsTechnician,
          isTechnician: technicianAccessEventsTable.isTechnician,
          changedAt: technicianAccessEventsTable.changedAt,
          changedBy: {
            id: changedByUserTable.id,
            email: changedByUserTable.email,
            firstName: changedByUserTable.firstName,
            lastName: changedByUserTable.lastName,
          },
        })
        .from(technicianAccessEventsTable)
        .innerJoin(
          changedByUserTable,
          eq(technicianAccessEventsTable.changedByUserId, changedByUserTable.id),
        )
        .where(eq(technicianAccessEventsTable.technicianId, technicianId))
        .orderBy(
          desc(technicianAccessEventsTable.changedAt),
          desc(technicianAccessEventsTable.id),
        );

      res.json(
        GetTechnicianAccessHistoryResponse.parse({ technicianId, events }),
      );
    } catch (error) {
      req.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Failed to load technician access history",
      );
      res.status(503).json({ error: "Technician access history is temporarily unavailable" });
    }
  },
);

router.patch(
  "/admin/technicians/:userId",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = UpdateTechnicianAccessBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid technician access update" });
      return;
    }
    if (!req.dbUser) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const targetUserId = req.params.userId;
    if (typeof targetUserId !== "string") {
      res.status(400).json({ error: "Invalid workspace account ID" });
      return;
    }
    try {
      const account = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: usersTable.id,
            email: usersTable.email,
            firstName: usersTable.firstName,
            lastName: usersTable.lastName,
            isTechnician: usersTable.isTechnician,
            createdAt: usersTable.createdAt,
          })
          .from(usersTable)
          .where(eq(usersTable.id, targetUserId))
          .for("update")
          .limit(1);
        if (!current) return null;

        if (current.isTechnician !== parsed.data.isTechnician) {
          const [updated] = await tx
            .update(usersTable)
            .set({ isTechnician: parsed.data.isTechnician })
            .where(eq(usersTable.id, current.id))
            .returning({
              id: usersTable.id,
              email: usersTable.email,
              firstName: usersTable.firstName,
              lastName: usersTable.lastName,
              isTechnician: usersTable.isTechnician,
              createdAt: usersTable.createdAt,
            });
          await tx.insert(technicianAccessEventsTable).values({
            technicianId: current.id,
            changedByUserId: req.dbUser!.id,
            previousIsTechnician: current.isTechnician,
            isTechnician: parsed.data.isTechnician,
          });
          return updated;
        }
        return current;
      });

      if (!account) {
        res.status(404).json({ error: "Workspace account not found" });
        return;
      }
      res.json(UpdateTechnicianAccessResponse.parse(account));
    } catch (error) {
      req.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Failed to update technician access",
      );
      res.status(503).json({ error: "Technician access could not be updated" });
    }
  },
);

export default router;
