import type { DurableObjectState, WebSocket } from "@cloudflare/workers-types"

export class NotificationManager {
  state: DurableObjectState
  websockets: WebSocket[]

  constructor(state: DurableObjectState) {
    this.state = state
    this.websockets = []
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request)
    }

    return new Response("Expected websocket!", { status: 426 })
  }

  async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const ws = pair[0]
    const client = pair[1]

    client.accept()

    this.websockets.push(client)

    client.addEventListener("message", async (msg) => {
      try {
        const parsedMessage = JSON.parse(msg.data as string)

        if (parsedMessage.type === "subscribe") {
          // Handle subscription logic here (e.g., store user preferences)
          console.log(`User subscribed to: ${parsedMessage.topic}`)
          client.send(`Subscribed to ${parsedMessage.topic}`)
        } else {
          console.log("Received message:", parsedMessage)
        }
      } catch (e) {
        console.error("Failed to parse message:", e)
        client.send("Error: Invalid message format.")
      }
    })

    client.addEventListener("close", () => {
      this.websockets = this.websockets.filter((socket) => socket !== client)
    })

    client.addEventListener("error", (error) => {
      console.error("WebSocket error:", error)
      this.websockets = this.websockets.filter((socket) => socket !== client)
    })

    return new Response(null, { status: 101, webSocket: ws })
  }

  async broadcast(message: string): Promise<void> {
    this.websockets = this.websockets.filter((socket) => {
      try {
        socket.send(message)
        return true
      } catch (e) {
        console.error("Failed to send message:", e)
        try {
          socket.close(1011, "Failed to send message.")
        } catch (e) {
          console.error("Failed to close socket:", e)
        }
        return false
      }
    })
  }
}
