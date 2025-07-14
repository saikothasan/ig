import { Hono } from "hono"
import { desc, eq, sql } from "drizzle-orm"
import { authMiddleware, type UserPayload } from "../middleware/auth"
import { conversations, conversationParticipants, messages, users } from "../db/schema"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type { DurableObjectNamespace } from "@cloudflare/workers-types"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"

type Bindings = {
  db: DrizzleD1Database
  DM_CHAT_ROOM: DurableObjectNamespace
}

type Variables = {
  user: UserPayload
}

export const dmRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

dmRoutes.use("*", authMiddleware())

// Get all conversations for the logged-in user
dmRoutes.get("/conversations", async (c) => {
  const db = c.get("db")
  const user = c.get("user")

  const userConversations = await db
    .select({
      conversationId: conversations.id,
      otherUser: {
        id: users.id,
        username: users.username,
        avatarUrl: users.avatarUrl,
      },
      lastMessage: sql<string>`(
        SELECT text FROM ${messages}
        WHERE conversation_id = ${conversations.id}
        ORDER BY created_at DESC
        LIMIT 1
      )`,
    })
    .from(conversations)
    .innerJoin(conversationParticipants as any, eq(conversations.id, conversationParticipants.conversationId))
    .innerJoin(users, eq(conversationParticipants.userId, users.id))
    .where(
      sql`${conversations.id} IN (
        SELECT conversation_id FROM ${conversationParticipants} WHERE user_id = ${user.sub}
      ) AND ${users.id} != ${user.sub}`,
    )

  return c.json(userConversations)
})

// Get messages for a specific conversation
dmRoutes.get("/conversations/:id", async (c) => {
  const conversationId = c.req.param("id")
  const db = c.get("db")
  // In a real app, you'd verify the user is a participant
  const convMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(50)

  return c.json(convMessages.reverse())
})

// Send a message
const sendMessageSchema = z.object({ text: z.string().min(1) })
dmRoutes.post("/conversations/:id", zValidator("json", sendMessageSchema), async (c) => {
  const conversationId = c.req.param("id")
  const { text } = c.req.valid("json")
  const user = c.get("user")
  const db = c.get("db")

  const newMessage = await db
    .insert(messages)
    .values({
      conversationId,
      senderId: user.sub,
      text,
    })
    .returning()
    .get()

  // Broadcast via Durable Object
  const doId = c.env.DM_CHAT_ROOM.idFromName(conversationId)
  const stub = c.env.DM_CHAT_ROOM.get(doId)
  await stub.fetch("http://.../broadcast", {
    method: "POST",
    body: JSON.stringify(newMessage),
  })

  return c.json(newMessage, 201)
})

// NEW: Start or get a conversation with a user
dmRoutes.post("/conversations/start", zValidator("json", z.object({ userId: z.string() })), async (c) => {
  const { userId: otherUserId } = c.req.valid("json")
  const currentUser = c.get("user")
  const db = c.get("db")

  // Check if a conversation already exists
  const existingConversation = await db.execute(sql`
    SELECT t1.conversation_id
    FROM ${conversationParticipants} t1
    JOIN ${conversationParticipants} t2 ON t1.conversation_id = t2.conversation_id
    WHERE t1.user_id = ${currentUser.sub} AND t2.user_id = ${otherUserId}
  `)

  if (existingConversation.rows.length > 0) {
    return c.json({ conversationId: existingConversation.rows[0].conversation_id })
  }

  // Create a new conversation
  const newConversation = await db.insert(conversations).values({}).returning({ id: conversations.id }).get()
  await db.insert(conversationParticipants).values([
    { conversationId: newConversation.id, userId: currentUser.sub },
    { conversationId: newConversation.id, userId: otherUserId },
  ])

  return c.json({ conversationId: newConversation.id }, 201)
})
