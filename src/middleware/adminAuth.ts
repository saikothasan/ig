import { createMiddleware } from "hono/factory"
import { eq } from "drizzle-orm"
import { users } from "../db/schema"
import type { UserPayload } from "./auth"

// This middleware checks if the authenticated user has the 'admin' role.
export const adminAuthMiddleware = () => {
  return createMiddleware(async (c, next) => {
    const userPayload = c.get("user") as UserPayload
    if (!userPayload) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const db = c.get("db")
    const user = await db.select({ role: users.role }).from(users).where(eq(users.id, userPayload.sub)).get()

    if (user?.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403)
    }

    await next()
  })
}
