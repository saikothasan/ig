import { type DurableObjectState, type WebSocket, WebSocketPair } from "@cloudflare/workers"

export class NotificationManager {
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
      this.send(message)
      return new Response("Sent", { status: 200 })
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
      console.error(`Notification WebSocket error:`, err)
      this.sessions = this.sessions.filter((s) => s !== session)
    })
  }

  send(message: string) {
    this.sessions.forEach((session) => {
      try {
        session.send(message)
      } catch (e) {
        console.error("Failed to send notification to a session, removing it.", e)
        this.sessions = this.sessions.filter((s) => s !== session)
      }
    })
  }
}
