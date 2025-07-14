import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { drizzle } from "drizzle-orm/neon-http"
import { neon } from "@neondatabase/serverless"
import * as schema from "./db/schema"
import type { R2Bucket, DurableObjectNamespace } from "@cloudflare/workers-types"

import { authRoutes } from "./routes/auth"
import { postRoutes } from "./routes/posts"
import { userRoutes } from "./routes/users"
import { commentRoutes } from "./routes/comments"
import { storyRoutes } from "./routes/stories"
import { dmRoutes } from "./routes/dm"
import { notificationRoutes } from "./routes/notifications"
import { adminRoutes } from "./routes/admin"
import { CommentRoom } from "./durable-objects/CommentRoom"
import { DMChatRoom } from "./durable-objects/DMChatRoom"
import { NotificationManager } from "./durable-objects/NotificationManager"

// This setup is for Cloudflare Workers. The `Bindings` type defines the environment variables.
type Bindings = {
  DATABASE_URL: string
  JWT_SECRET: string
  R2_BUCKET: R2Bucket
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  COMMENT_ROOM: DurableObjectNamespace
  DM_CHAT_ROOM: DurableObjectNamespace
  NOTIFICATION_MANAGER: DurableObjectNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

// Middleware
app.use("*", logger())
app.use("*", cors())

// Database connection
app.use("*", async (c, next) => {
  const sql = neon(c.env.DATABASE_URL)
  const db = drizzle(sql, { schema })
  c.set("db", db)
  await next()
})

// API Routes
app.route("/api/auth", authRoutes)
app.route("/api/posts", postRoutes)
app.route("/api/users", userRoutes)
app.route("/api/posts", commentRoutes)
app.route("/api/stories", storyRoutes)
app.route("/api/dm", dmRoutes)
app.route("/api/notifications", notificationRoutes)
app.route("/api/admin", adminRoutes)

// WebSocket route for real-time comments
app.get("/api/ws/posts/:postId", async (c) => {
  const upgradeHeader = c.req.header("Upgrade")
  if (upgradeHeader !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426)
  }
  const postId = c.req.param("postId")
  const doId = c.env.COMMENT_ROOM.idFromName(postId)
  const stub = c.env.COMMENT_ROOM.get(doId)
  return stub.fetch(c.req.raw)
})

// WebSocket route for DMs
app.get("/api/ws/dm/:conversationId", async (c) => {
  const upgradeHeader = c.req.header("Upgrade")
  if (upgradeHeader !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426)
  }
  const conversationId = c.req.param("conversationId")
  const doId = c.env.DM_CHAT_ROOM.idFromName(conversationId)
  const stub = c.env.DM_CHAT_ROOM.get(doId)
  return stub.fetch(c.req.raw)
})

// WebSocket route for user notifications
app.get("/api/ws/notifications/:userId", async (c) => {
  const upgradeHeader = c.req.header("Upgrade")
  if (upgradeHeader !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426)
  }
  const userId = c.req.param("userId")
  const doId = c.env.NOTIFICATION_MANAGER.idFromName(userId)
  const stub = c.env.NOTIFICATION_MANAGER.get(doId)
  return stub.fetch(c.req.raw)
})

app.get("/", (c) => {
  return c.json({ message: "Instagram Clone API" })
})

// Export the Durable Object as well
export { CommentRoom, DMChatRoom, NotificationManager }
export default app
