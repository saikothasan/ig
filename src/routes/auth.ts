import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { sign } from "hono/jwt"
import { hash, compare } from "bcryptjs"
import { users } from "../db/schema"
import { eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { authMiddleware, type UserPayload } from "../middleware/auth"

type Bindings = {
  db: DrizzleD1Database
  JWT_SECRET: string
}

export const authRoutes = new Hono<{ Bindings: Bindings }>()

const registerSchema = z.object({
  username: z.string().min(3).max(50),
  email: z.string().email(),
  password: z.string().min(8),
})

authRoutes.post("/register", zValidator("json", registerSchema), async (c) => {
  const { username, email, password } = c.req.valid("json")
  const db = c.get("db")

  const hashedPassword = await hash(password, 10)

  try {
    const newUser = await db
      .insert(users)
      .values({
        username,
        email,
        passwordHash: hashedPassword,
      })
      .returning({ id: users.id, username: users.username, email: users.email })
      .get()

    return c.json({ user: newUser, message: "User created successfully" }, 201)
  } catch (error: any) {
    // Handle potential unique constraint errors
    if (error.message?.includes("UNIQUE constraint failed")) {
      return c.json({ error: "Username or email already exists" }, 409)
    }
    console.error(error)
    return c.json({ error: "Failed to create user" }, 500)
  }
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

authRoutes.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json")
  const db = c.get("db")

  const user = await db.select().from(users).where(eq(users.email, email)).get()

  if (!user) {
    return c.json({ error: "Invalid credentials" }, 401)
  }

  const isPasswordValid = await compare(password, user.passwordHash)

  if (!isPasswordValid) {
    return c.json({ error: "Invalid credentials" }, 401)
  }

  const payload = {
    sub: user.id,
    username: user.username,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24 hours
  }
  const token = await sign(payload, c.env.JWT_SECRET)

  return c.json({ token })
})

// NEW: Get current user info
authRoutes.get("/me", authMiddleware(), async (c) => {
  const userPayload = c.get("user") as UserPayload
  const db = c.get("db")

  const user = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      avatarUrl: users.avatarUrl,
      bio: users.bio,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userPayload.sub))
    .get()

  if (!user) {
    return c.json({ error: "User not found" }, 404)
  }
  return c.json(user)
})
