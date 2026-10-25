import { getAuth } from "@clerk/express";
import { db, usersTable, type User } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";

declare global {
  namespace Express {
    interface Request {
      dbUser?: User;
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  // Never use Clerk's native ID to look up migrated local users.
  const userId = auth.sessionClaims?.userId;
  if (typeof userId !== "string" || !userId) {
    res.status(401).json({ error: "Account identity is missing from the session" });
    return;
  }
  try {
    const claims = auth.sessionClaims;
    const profile = {
      email: typeof claims?.email === "string" ? claims.email : null,
      firstName: typeof claims?.firstName === "string" ? claims.firstName : null,
      lastName: typeof claims?.lastName === "string" ? claims.lastName : null,
    };
    let [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) {
      [user] = await db
        .insert(usersTable)
        .values({ id: userId, ...profile })
        .onConflictDoNothing()
        .returning();
      if (!user) {
        [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      }
    }
    if (!user) throw new Error("Unable to provision local account");
    const profileChanged =
      user.email !== profile.email ||
      user.firstName !== profile.firstName ||
      user.lastName !== profile.lastName;
    if (profileChanged) {
      [user] = await db
        .update(usersTable)
        .set(profile)
        .where(eq(usersTable.id, userId))
        .returning();
    }
    req.dbUser = user;
    next();
  } catch (error) {
    next(error);
  }
};
