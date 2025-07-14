import type { DurableObjectState, WebSocket } from "@cloudflare/workers-types"
// This defines a Durable Object class.
// To use it, you must configure it in your wrangler.toml file.
// See: https://developers.cloudflare.com/workers/learning/using-durable-objects/

export class CommentRoom {
  state: DurableObjectState
  sessions: WebSocket[] = []

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair()
      this.handleSession(server)
      return new Response(null, { status: 101, webSocket: client })
    }

    if (request.method === "POST") {
      const message = await request.text()
      this.broadcast(message)
      return new Response("Broadcasted", { status: 200 })
    }

    return new Response("Not found", { status: 404 })
  }

  handleSession(session: WebSocket) {
    this.sessions.push(session)
    session.accept()

    session.addEventListener("close", () => {
      this.sessions = this.sessions.filter((s) => s !== session)
    })
    session.addEventListener("error", (err) => {
      console.error(`WebSocket error:`, err)
      this.sessions = this.sessions.filter((s) => s !== session)
    })
  }

  broadcast(message: string) {
    this.sessions.forEach((session) => {
      try {
        session.send(message)
      } catch (e) {
        this.sessions = this.sessions.filter((s) => s !== session)
      }
    })
  }
}
