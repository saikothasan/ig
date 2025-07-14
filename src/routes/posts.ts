import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createId } from "@paralleldrive/cuid2"
import { authMiddleware } from "../middleware/auth"
import { posts, likes, comments, follows, notifications, reports } from "../db/schema" // Add reports
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type { UserPayload } from "../middleware/auth"
import type { R2Bucket } from "@cloudflare/workers-types"
import { and, desc, eq, sql, inArray } from "drizzle-orm"
import { users } from "../db/schema"
import type { NotificationManager } from "../durable-objects/NotificationManager"
import type { DurableObjectNamespace } from "@cloudflare/workers-types"

type Bindings = {
  db: DrizzleD1Database
  R2_BUCKET: R2Bucket
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  NOTIFICATION_MANAGER: DurableObjectNamespace<NotificationManager>
}

type Variables = {
  user: UserPayload
}

export const postRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// All post routes require authentication
postRoutes.use("*", authMiddleware())

const paginationSchema = z.object({
  page: z.string().optional().default("1").transform(Number),
})

// GET /api/posts/p/:id - Get single post details
postRoutes.get("/p/:id", async (c) => {
  const postId = c.req.param("id")
  const user = c.get("user")
  const db = c.get("db")

  const postDetails = await db.query.posts.findFirst({
    where: eq(posts.id, postId),
    with: {
      user: { columns: { username: true, avatarUrl: true } },
      comments: {
        with: { user: { columns: { username: true, avatarUrl: true } } },
        orderBy: desc(comments.createdAt),
      },
    },
  })

  if (!postDetails) {
    return c.json({ error: "Post not found" }, 404)
  }

  const likesCount = await db.select({ count: sql<number>`count(*)` }).from(likes).where(eq(likes.postId, postId))
  const isLiked = await db
    .select()
    .from(likes)
    .where(and(eq(likes.postId, postId), eq(likes.userId, user.sub)))
    .get()

  return c.json({
    ...postDetails,
    likesCount: likesCount[0].count,
    isLiked: !!isLiked,
  })
})

// GET /api/posts/explore
postRoutes.get("/explore", zValidator("query", paginationSchema), async (c) => {
  const { page } = c.req.valid("query")
  const limit = 21
  const offset = (page - 1) * limit
  const db = c.get("db")

  const explorePosts = await db
    .select({
      id: posts.id,
      imageUrl: posts.imageUrl,
      likesCount: sql<number>`(select count(*) from "likes" where "likes"."post_id" = ${posts.id})`.mapWith(Number),
      commentsCount: sql<number>`(select count(*) from "comments" where "comments"."post_id" = ${posts.id})`.mapWith(
        Number,
      ),
    })
    .from(posts)
    .orderBy(desc(posts.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json(explorePosts)
})

// GET /api/posts/feed
postRoutes.get("/feed", zValidator("query", paginationSchema), async (c) => {
  const { page } = c.req.valid("query")
  const limit = 10
  const offset = (page - 1) * limit
  const db = c.get("db")
  const user = c.get("user")

  try {
    // Find who the current user follows
    const followedUsers = await db
      .select({ id: follows.followingId })
      .from(follows)
      .where(eq(follows.followerId, user.sub))

    const followedUserIds = followedUsers.map((f) => f.id)
    // Always include user's own posts in their feed
    const userIdsForFeed = [...new Set([user.sub, ...followedUserIds])]

    if (userIdsForFeed.length === 0) {
      return c.json([])
    }

    const feedPosts = await db
      .select({
        id: posts.id,
        imageUrl: posts.imageUrl,
        caption: posts.caption,
        createdAt: posts.createdAt,
        user: {
          id: users.id,
          username: users.username,
          avatarUrl: users.avatarUrl,
        },
        likesCount: sql<number>`(select count(*) from ${likes} where ${likes.postId} = ${posts.id})`.mapWith(Number),
        isLiked:
          sql<boolean>`exists(select 1 from ${likes} where ${likes.postId} = ${posts.id} and ${likes.userId} = ${user.sub})`.mapWith(
            Boolean,
          ),
        commentsCount: sql<number>`(select count(*) from ${comments} where ${comments.postId} = ${posts.id})`.mapWith(
          Number,
        ),
      })
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .where(inArray(posts.userId, userIdsForFeed)) // The key change is here
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset)

    return c.json(feedPosts)
  } catch (error) {
    console.error("Failed to fetch feed:", error)
    return c.json({ error: "Failed to fetch feed" }, 500)
  }
})

// POST /api/posts/:id/report
const reportSchema = z.object({ reason: z.string().optional() })
postRoutes.post("/:id/report", zValidator("json", reportSchema), async (c) => {
  const postId = c.req.param("id")
  const { reason } = c.req.valid("json")
  const user = c.get("user")
  const db = c.get("db")

  await db.insert(reports).values({
    reporterId: user.sub,
    entityId: postId,
    entityType: "post",
    reason,
  })

  return c.json({ success: true, message: "Post reported" })
})

// POST /api/posts/:id/like
postRoutes.post("/:id/like", async (c) => {
  const postId = c.req.param("id")
  const user = c.get("user")
  const db = c.get("db")

  try {
    const existingLike = await db
      .select()
      .from(likes)
      .where(and(eq(likes.postId, postId), eq(likes.userId, user.sub)))
      .get()
    if (existingLike) {
      return c.json({ message: "Post already liked" }, 200)
    }
    await db.insert(likes).values({ postId, userId: user.sub })

    // Create notification
    const postOwner = await db.select({ userId: posts.userId }).from(posts).where(eq(posts.id, postId)).get()
    if (postOwner && postOwner.userId !== user.sub) {
      await db.insert(notifications).values({
        recipientId: postOwner.userId,
        actorId: user.sub,
        type: "like",
        entityId: postId,
      })

      // NEW: Trigger real-time notification
      const doId = c.env.NOTIFICATION_MANAGER.idFromName(postOwner.userId)
      const stub = c.env.NOTIFICATION_MANAGER.get(doId)
      const message = `${user.username} liked your post.`
      await stub.fetch("http://.../send", { method: "POST", body: message })
    }

    return c.json({ success: true, message: "Post liked" }, 201)
  } catch (error) {
    console.error("Failed to like post:", error)
    return c.json({ error: "Failed to like post" }, 500)
  }
})

// DELETE /api/posts/:id/like
postRoutes.delete("/:id/like", async (c) => {
  const postId = c.req.param("id")
  const user = c.get("user")
  const db = c.get("db")

  try {
    await db.delete(likes).where(and(eq(likes.postId, postId), eq(likes.userId, user.sub)))
    return c.json({ success: true, message: "Post unliked" })
  } catch (error) {
    console.error("Failed to unlike post:", error)
    return c.json({ error: "Failed to unlike post" }, 500)
  }
})

// 1. Get a pre-signed URL for upload
const presignedUrlSchema = z.object({
  contentType: z.string().startsWith("image/"),
})

postRoutes.post("/presigned-url", zValidator("json", presignedUrlSchema), async (c) => {
  const { contentType } = c.req.valid("json")
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = c.env
  const bucketName = c.env.R2_BUCKET.bucketName

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  })

  const fileExtension = contentType.split("/")[1]
  const key = `uploads/${createId()}.${fileExtension}`

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 3600 }, // 1 hour
  )

  return c.json({ url, key })
})

// 2. Create the post record after upload is complete
const createPostSchema = z.object({
  imageUrl: z.string().url(),
  caption: z.string().optional(),
})

postRoutes.post("/", zValidator("json", createPostSchema), async (c) => {
  const { imageUrl, caption } = c.req.valid("json")
  const user = c.get("user")
  const db = c.get("db")

  const newPost = await db
    .insert(posts)
    .values({
      userId: user.sub,
      imageUrl,
      caption,
    })
    .returning()
    .get()

  return c.json(newPost, 201)
})

// NEW: Update a post
const updatePostSchema = z.object({ caption: z.string().optional() })
postRoutes.put("/:id", zValidator("json", updatePostSchema), async (c) => {
  const postId = c.req.param("id")
  const { caption } = c.req.valid("json")
  const user = c.get("user")
  const db = c.get("db")

  const post = await db.select({ userId: posts.userId }).from(posts).where(eq(posts.id, postId)).get()
  if (post?.userId !== user.sub) {
    return c.json({ error: "Forbidden" }, 403)
  }

  await db.update(posts).set({ caption }).where(eq(posts.id, postId))
  return c.json({ success: true })
})

// NEW: Delete a post
postRoutes.delete("/:id", async (c) => {
  const postId = c.req.param("id")
  const user = c.get("user")
  const db = c.get("db")

  const post = await db.select({ userId: posts.userId }).from(posts).where(eq(posts.id, postId)).get()
  if (post?.userId !== user.sub) {
    return c.json({ error: "Forbidden" }, 403)
  }

  await db.delete(posts).where(eq(posts.id, postId))
  // Note: R2 objects are not deleted here to keep it simple.
  // A production system would have a cleanup job.
  return c.json({ success: true })
})
