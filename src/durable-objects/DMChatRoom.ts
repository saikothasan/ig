import type { DurableObjectState, WebSocket } from "@cloudflare/workers-types"

export class DMChatRoom {
  state: DurableObjectState
  sessions: WebSocket[] = []

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request) {
    // If the request is a WebSocket upgrade, handle it.
    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair()
      this.handleSession(server)
      return new Response(null, { status: 101, webSocket: client })
    }

    // If the request is a POST, it's a message from the REST API to be broadcasted.
    if (request.method === "POST") {
      const message = await request.text()
      this.broadcast(message)
      return new Response("Message broadcasted", { status: 200 })
    }

    return new Response("Not found", { status: 404 })
  }

  // handleSession manages a new WebSocket connection.
  handleSession(session: WebSocket) {
    this.sessions.push(session)
    session.accept()

    // When a client sends a message, broadcast it to all other clients.
    session.addEventListener("message", (msg) => {
      this.broadcast(msg.data as string)
    })

    // Clean up the session on close or error.
    const closeOrErrorHandler = () => {
      this.sessions = this.sessions.filter((s) => s !== session)
    }
    session.addEventListener("close", closeOrErrorHandler)
    session.addEventListener("error", closeOrErrorHandler)
  }

  // broadcast sends a message to all connected clients.
  broadcast(message: string) {
    // Iterate over all sessions and send the message.
    // If a session is closed, remove it from the list.
    this.sessions = this.sessions.filter((session) => {
      try {
        session.send(message)
        return true
      } catch (err) {
        return false
      }
    })
  }
}
