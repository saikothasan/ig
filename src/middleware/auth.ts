import { createMiddleware } from "hono/factory"
import { verify } from "hono/jwt"

export type UserPayload = {
  sub: string
  username: string
}

export const authMiddleware = () => {
  return createMiddleware(async (c, next) => {
    const authHeader = c.req.header("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const token = authHeader.split(" ")[1]
    try {
      const payload = await verify(token, c.env.JWT_SECRET)
      c.set("user", payload as UserPayload)
      await next()
    } catch (error) {
      return c.json({ error: "Invalid token" }, 401)
    }
  })
}
