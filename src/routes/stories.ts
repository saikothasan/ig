import { Hono } from "hono"
import { sql, eq, inArray, desc, gte, and } from "drizzle-orm"
import { authMiddleware, type UserPayload } from "../middleware/auth"
import { stories, users, follows } from "../db/schema"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"

type Bindings = {
  db: DrizzleD1Database
}

type Variables = {
  user: UserPayload
}

export const storyRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

storyRoutes.use("*", authMiddleware())

// NEW: Create a story
const createStorySchema = z.object({
  mediaUrl: z.string().url(),
  mediaType: z.enum(["image", "video"]),
})
storyRoutes.post("/", zValidator("json", createStorySchema), async (c) => {
  const { mediaUrl, mediaType } = c.req.valid("json")
  const user = c.get("user")
  const db = c.get("db")

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now

  await db.insert(stories).values({
    userId: user.sub,
    mediaUrl,
    mediaType,
    expiresAt,
  })

  return c.json({ success: true }, 201)
})

// Fetch stories for the feed (from followed users)
storyRoutes.get("/feed", async (c) => {
  const db = c.get("db")
  const user = c.get("user")

  const followedUsers = await db
    .select({ id: follows.followingId })
    .from(follows)
    .where(eq(follows.followerId, user.sub))
  const followedUserIds = followedUsers.map((f) => f.id)
  const userIdsForFeed = [...new Set([user.sub, ...followedUserIds])]

  if (userIdsForFeed.length === 0) {
    return c.json([])
  }

  const activeStories = await db
    .select({
      userId: stories.userId,
      username: users.username,
      avatarUrl: users.avatarUrl,
      stories: sql<
        { id: string; mediaUrl: string }[]
      >`json_agg(json_build_object('id', ${stories.id}, 'mediaUrl', ${stories.mediaUrl}))`,
    })
    .from(stories)
    .innerJoin(users, eq(stories.userId, users.id))
    .where(and(inArray(stories.userId, userIdsForFeed), gte(stories.expiresAt, new Date())))
    .groupBy(stories.userId, users.username, users.avatarUrl)
    .orderBy(desc(sql`max(${stories.createdAt})`))

  return c.json(activeStories)
})
