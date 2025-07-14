import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { eq, desc } from "drizzle-orm"
import { authMiddleware } from "../middleware/auth"
import { comments, users } from "../db/schema"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type { UserPayload } from "../middleware/auth"
import type { DurableObjectNamespace } from "@cloudflare/workers-types"

type Bindings = {
  db: DrizzleD1Database
  COMMENT_ROOM: DurableObjectNamespace
}

type Variables = {
  user: UserPayload
}

export const commentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// Fetch comments for a post
commentRoutes.get("/:postId/comments", async (c) => {
  const postId = c.req.param("postId")
  const db = c.get("db")

  const postComments = await db
    .select({
      id: comments.id,
      text: comments.text,
      createdAt: comments.createdAt,
      user: {
        username: users.username,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.postId, postId))
    .orderBy(desc(comments.createdAt))

  return c.json(postComments)
})

// Create a comment (requires auth)
const createCommentSchema = z.object({
  text: z.string().min(1).max(1000),
})

commentRoutes.post("/:postId/comments", authMiddleware(), zValidator("json", createCommentSchema), async (c) => {
  const postId = c.req.param("postId")
  const { text } = c.req.valid("json")
  const user = c.get("user")
  const db = c.get("db")

  try {
    const newCommentData = await db
      .insert(comments)
      .values({
        postId,
        userId: user.sub,
        text,
      })
      .returning({
        id: comments.id,
        text: comments.text,
        createdAt: comments.createdAt,
      })
      .get()

    const commentWithUser = {
      ...newCommentData,
      user: {
        username: user.username,
        avatarUrl: null, // Can be fetched if needed, but username is enough for broadcast
      },
    }

    // Notify the durable object to broadcast the new comment
    const doId = c.env.COMMENT_ROOM.idFromName(postId)
    const stub = c.env.COMMENT_ROOM.get(doId)
    await stub.fetch("http://.../broadcast", {
      method: "POST",
      body: JSON.stringify(commentWithUser),
    })

    return c.json(commentWithUser, 201)
  } catch (error) {
    console.error("Failed to create comment:", error)
    return c.json({ error: "Failed to create comment" }, 500)
  }
})
