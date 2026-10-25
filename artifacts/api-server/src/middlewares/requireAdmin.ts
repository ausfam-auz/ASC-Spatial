import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

function configuredAdminEmails(): Set<string> {
  // Provision administrators with comma-separated emails in server configuration.
  // The signed Clerk session claim is checked on every request; client-provided roles are ignored.
  return new Set(
    (process.env.ASC_SPATIAL_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isWorkspaceAdmin(email: string | null | undefined): boolean {
  return !!email && configuredAdminEmails().has(email.trim().toLowerCase());
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.dbUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const email = getAuth(req).sessionClaims?.email;
  if (!isWorkspaceAdmin(typeof email === "string" ? email : null)) {
    res.status(403).json({ error: "Workspace administrator access required" });
    return;
  }
  next();
};
