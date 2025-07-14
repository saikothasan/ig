import { Hono } from "hono"
import { eq, desc, sql, and, ilike } from "drizzle-orm"
import { users, posts, follows, notifications } from "../db/schema"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { authMiddleware, type UserPayload } from "../middleware/auth"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import type { DurableObjectNamespace } from "workers-types"
import type { NotificationManager } from "../durable-objects/NotificationManager"

type Bindings = {
  db: DrizzleD1Database
  NOTIFICATION_MANAGER: DurableObjectNamespace<NotificationManager>
}

type Variables = {
  user: UserPayload
}

export const userRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// NEW: Update user profile
const updateProfileSchema = z.object({
  bio: z.string().optional(),
  avatarUrl: z.string().url().optional(),
})
userRoutes.put("/profile", authMiddleware(), zValidator("json", updateProfileSchema), async (c) => {
  const { bio, avatarUrl } = c.req.valid("json")
  const user = c.get("user")
  const db = c.get("db")

  await db.update(users).set({ bio, avatarUrl }).where(eq(users.id, user.sub))

  return c.json({ success: true })
})

// Search for users
userRoutes.get("/search", authMiddleware(), async (c) => {
  const query = c.req.query("q")
  if (!query) {
    return c.json([])
  }
  const db = c.get("db")
  const foundUsers = await db
    .select({
      id: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(ilike(users.username, `%${query}%`))
    .limit(10)

  return c.json(foundUsers)
})

// This route now needs to know who is viewing the profile to determine the follow status.
userRoutes.get("/:username", authMiddleware(), async (c) => {
  const username = c.req.param("username")
  const viewingUser = c.get("user")
  const db = c.get("db")

  try {
    const userProfile = await db.select().from(users).where(eq(users.username, username)).get()

    if (!userProfile) {
      return c.json({ error: "User not found" }, 404)
    }

    const [counts, userPosts] = await Promise.all([
      db
        .select({
          postsCount: sql<number>`(select count(*) from ${posts} where ${posts.userId} = ${userProfile.id})`.mapWith(
            Number,
          ),
          followersCount:
            sql<number>`(select count(*) from ${follows} where ${follows.followingId} = ${userProfile.id})`.mapWith(
              Number,
            ),
          followingCount:
            sql<number>`(select count(*) from ${follows} where ${follows.followerId} = ${userProfile.id})`.mapWith(
              Number,
            ),
          isFollowing:
            sql<boolean>`exists(select 1 from ${follows} where ${follows.followerId} = ${viewingUser.sub} and ${follows.followingId} = ${userProfile.id})`.mapWith(
              Boolean,
            ),
        })
        .from(users)
        .where(eq(users.id, userProfile.id))
        .get(),
      db
        .select({
          id: posts.id,
          imageUrl: posts.imageUrl,
          likesCount: sql<number>`(select count(*) from "likes" where "likes"."post_id" = ${posts.id})`.mapWith(Number),
          commentsCount:
            sql<number>`(select count(*) from "comments" where "comments"."post_id" = ${posts.id})`.mapWith(Number),
        })
        .from(posts)
        .where(eq(posts.userId, userProfile.id))
        .orderBy(desc(posts.createdAt)),
    ])

    return c.json({
      ...userProfile,
      ...counts,
      posts: userPosts,
    })
  } catch (error) {
    console.error("Failed to fetch user profile:", error)
    return c.json({ error: "Failed to fetch user profile" }, 500)
  }
})

// Follow a user
userRoutes.post("/:id/follow", authMiddleware(), async (c) => {
  const userToFollowId = c.req.param("id")
  const currentUser = c.get("user")
  const db = c.get("db")

  if (userToFollowId === currentUser.sub) {
    return c.json({ error: "You cannot follow yourself" }, 400)
  }

  try {
    await db.insert(follows).values({
      followerId: currentUser.sub,
      followingId: userToFollowId,
    })

    // NEW: Create and trigger notification
    await db.insert(notifications).values({
      recipientId: userToFollowId,
      actorId: currentUser.sub,
      type: "follow",
    })
    const doId = c.env.NOTIFICATION_MANAGER.idFromName(userToFollowId)
    const stub = c.env.NOTIFICATION_MANAGER.get(doId)
    const message = `${currentUser.username} started following you.`
    await stub.fetch("http://.../send", { method: "POST", body: message })

    return c.json({ success: true })
  } catch (error) {
    // Ignore unique constraint errors (already following)
    return c.json({ success: true })
  }
})

// Unfollow a user
userRoutes.delete("/:id/follow", authMiddleware(), async (c) => {
  const userToUnfollowId = c.req.param("id")
  const currentUser = c.get("user")
  const db = c.get("db")

  try {
    await db
      .delete(follows)
      .where(and(eq(follows.followerId, currentUser.sub), eq(follows.followingId, userToUnfollowId)))
    return c.json({ success: true })
  } catch (error) {
    console.error("Failed to unfollow user:", error)
    return c.json({ error: "Failed to unfollow user" }, 500)
  }
})
