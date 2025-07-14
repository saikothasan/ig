import { Hono } from "hono"
import { eq, desc } from "drizzle-orm"
import { authMiddleware } from "../middleware/auth"
import { adminAuthMiddleware } from "../middleware/adminAuth"
import { reports, users, posts } from "../db/schema"
import type { DrizzleD1Database } from "drizzle-orm/d1"

type Bindings = {
  db: DrizzleD1Database
}

export const adminRoutes = new Hono<{ Bindings: Bindings }>()

// Protect all admin routes
adminRoutes.use("*", authMiddleware(), adminAuthMiddleware())

// Get all unresolved reports
adminRoutes.get("/reports", async (c) => {
  const db = c.get("db")
  const unresolvedReports = await db
    .select({
      reportId: reports.id,
      reason: reports.reason,
      createdAt: reports.createdAt,
      reporter: { username: users.username },
      reportedPost: { id: posts.id, imageUrl: posts.imageUrl, caption: posts.caption },
    })
    .from(reports)
    .leftJoin(users, eq(reports.reporterId, users.id))
    .leftJoin(posts, eq(reports.entityId, posts.id))
    .where(eq(reports.resolved, false))
    .orderBy(desc(reports.createdAt))

  return c.json(unresolvedReports)
})

// Delete a post as an admin
adminRoutes.delete("/posts/:id", async (c) => {
  const postId = c.req.param("id")
  const db = c.get("db")
  await db.delete(posts).where(eq(posts.id, postId))
  // You might also want to resolve any reports associated with this post
  return c.json({ success: true })
})
