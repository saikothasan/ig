import { Hono } from "hono"
import { desc, eq } from "drizzle-orm"
import { authMiddleware, type UserPayload } from "../middleware/auth"
import { notifications, users } from "../db/schema"
import type { DrizzleD1Database } from "drizzle-orm/d1"

type Bindings = {
  db: DrizzleD1Database
}

type Variables = {
  user: UserPayload
}

export const notificationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

notificationRoutes.use("*", authMiddleware())

// Get notifications for the logged-in user
notificationRoutes.get("/", async (c) => {
  const db = c.get("db")
  const user = c.get("user")

  const userNotifications = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      entityId: notifications.entityId,
      read: notifications.read,
      createdAt: notifications.createdAt,
      actor: {
        username: users.username,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(notifications)
    .innerJoin(users, eq(notifications.actorId, users.id))
    .where(eq(notifications.recipientId, user.sub))
    .orderBy(desc(notifications.createdAt))
    .limit(30)

  return c.json(userNotifications)
})

// Mark notifications as read
notificationRoutes.post("/read", async (c) => {
  const db = c.get("db")
  const user = c.get("user")

  await db.update(notifications).set({ read: true }).where(eq(notifications.recipientId, user.sub))

  return c.json({ success: true })
})
