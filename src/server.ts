import { createServer } from "http"
import { Server as IOServer, type Socket } from "socket.io"
import axios from "axios"
import { v4 as uuidv4 } from "uuid"
import dotenv from "dotenv"
dotenv.config()

interface ApiRoom {
  id: number | string
  session_key: string
  agent_name: string
  user_name: string
  status: string
  created_at: string
}

interface CreateRoomPayload {
  room_key: string
  name: string
  email?: string
  status: "open"
  content: string
  sender: "user" | "agent"
}

interface Message {
  sender: "user" | "agent"
  content: string
}

interface CreateOrSendPayload {
    room_key?: string
  name: string
  email?: string
  content: string
  sender: "user" | "agent"
}

interface SendMessagePayload {
  room_id?: number | string
  room_key?: string
  content: string
  sender?: "user" | "agent"
}

interface JoinRoomPayload {
  room_id?: number | string
  room_key?: string
}

interface ActionPayload {
  action: string
  description?: string
  [key: string]: any
}

interface TypingPayload {
  room_id?: number | string
  room_key?: string
  user_id: string
  user_name: string
}

interface StopTypingPayload {
  room_id?: number | string
  room_key?: string
  user_id: string
}

const PORT = Number(process.env.PORT || 3000)
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000"
const API_KEY = process.env.API_KEY || ""

const roomKeyToId = new Map<string, number | string>()

const httpServer = createServer((req, res) => {

  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }))
    return
  }

  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "Not found" }))
})


const io = new IOServer(httpServer, {
  connectionStateRecovery: {},
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

function apiHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`
  return headers
}

async function createRoomOnApi(payload: CreateRoomPayload): Promise<ApiRoom> {
  try {
    const resp = await axios.post<{ room: ApiRoom }>(`${API_BASE_URL}/rooms`, payload, {
      headers: apiHeaders(),
    })
    return resp.data.room
  } catch (err) {
    const e = err as any
    console.error("❌ Error creando sala:", e?.response?.data || e?.message || e)
    throw e
  }
}

function saveMessageAsync(roomId: number | string, message: Message) {
  axios
    .post(`${API_BASE_URL}/room/messages/${roomId}`, message, {
      headers: apiHeaders(),
    })
    .catch((err) => {
      const e = err as any
      console.error(`❌ Error guardando mensaje en room ${roomId}:`, e?.response?.data || e?.message || e)
    })
}

function resolveRoomId(room_id?: number | string, room_key?: string) {
  return room_id || (room_key ? roomKeyToId.get(room_key) : undefined)
}

io.on("connection", (socket: Socket) => {
  console.log(`⚡ Cliente conectado: ${socket.id}`)

  socket.on("create_or_send", async (payload: CreateOrSendPayload & { user_id?: string }) => {
    const { name, content, sender, email, user_id } = payload
    const room_key = `room_${uuidv4().split("-")[0]}`

    let createPayload: any = {
      room_key,
      content,
      sender,
      status: "open",
    }

    // Si se proporciona user_id, solo enviamos ese campo (omitimos email y name)
    if (user_id) {
      createPayload.user_id = user_id
      createPayload.session_key = null // Puede ser nulo en este caso
    } else {
      createPayload.email = email
      createPayload.name = name
    }

    try {
      const apiRoom = await createRoomOnApi(createPayload)
      const roomId = apiRoom.id

      roomKeyToId.set(room_key, roomId)
      socket.join(String(roomId))

      socket.emit("room_created", {
        room_id: roomId,
        room_key,
        user_name: apiRoom.user_name,
        agent_name: apiRoom.agent_name,
        session_key: apiRoom.session_key,
        status: apiRoom.status,
        created_at: apiRoom.created_at,
      })

      console.log(`✅ Sala creada: ${roomId} (${room_key})`)
    } catch {
      socket.emit("error_creating_room", {
        message: "No se pudo crear la sala",
      })
    }
  })

  socket.on("send_message", (payload: SendMessagePayload) => {
    const { room_id, room_key, content, sender = "user" } = payload

    const resolvedRoomId = resolveRoomId(room_id, room_key)
    if (!resolvedRoomId) {
      socket.emit("error", { message: "room_id o room_key requerido" })
      return
    }

    const msg: Message = { sender, content }

    io.to(String(resolvedRoomId)).emit("new_message", msg)
    saveMessageAsync(resolvedRoomId, msg)
  })

  socket.on("join_room", (payload: JoinRoomPayload) => {
    const resolvedRoomId = resolveRoomId(payload.room_id, payload.room_key)

    if (!resolvedRoomId) {
      socket.emit("error", {
        message: "room_id o room_key requerido para unirse",
      })
      return
    }

    socket.join(String(resolvedRoomId))
    socket.emit("joined_room", { room_id: resolvedRoomId })
    console.log(`✅ Cliente ${socket.id} unido a sala ${resolvedRoomId}`)
  })

  socket.on("user_typing", (payload: TypingPayload) => {
    const resolvedRoomId = resolveRoomId(payload.room_id, payload.room_key)
    if (!resolvedRoomId) return

    socket.to(String(resolvedRoomId)).emit("user_typing", {
      user_id: payload.user_id,
      user_name: payload.user_name,
      room_id: resolvedRoomId,
    })
  })

  socket.on("user_stop_typing", (payload: StopTypingPayload) => {
    const resolvedRoomId = resolveRoomId(payload.room_id, payload.room_key)
    if (!resolvedRoomId) return

    socket.to(String(resolvedRoomId)).emit("user_stop_typing", {
      user_id: payload.user_id,
      room_id: resolvedRoomId,
      timestamp: new Date().toISOString(),
    })
  })

  const actionEvents = [
    "checkout_initiated",
    "checkout_completed",
    "user_viewing_product",
    "user_left_product",
    "order_paid",
  ]

  actionEvents.forEach((eventName) => {
    socket.on(eventName, (payload: ActionPayload) => {
      const { room_id, room_key, ...eventData } = payload
      const resolvedRoomId = resolveRoomId(room_id, room_key)

      if (resolvedRoomId) {
        io.to(String(resolvedRoomId)).emit(eventName, eventData)
        console.log(`📢 Evento ${eventName} emitido a sala ${resolvedRoomId}`)
      } else {
        io.emit(eventName, payload)
        console.log(`📢 Evento ${eventName} emitido globalmente`)
      }
    })
  })

  socket.on("disconnect", () => {
    console.log(`⚠️ Cliente desconectado: ${socket.id}`)
  })
})

setInterval(() => {
  io.emit("heartbeat", { time: Date.now() })
  console.log("💓 Heartbeat emitido:", new Date().toISOString())
}, 40000)

async function startServer() {

  httpServer.listen(PORT, () => {
    console.log(`🚀 Socket.IO server corriendo en puerto ${PORT}`)
    console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`)
    console.log(`🏥 Health check: http://localhost:${PORT}/health`)
    console.log(`🌍 Entorno: ${process.env.NODE_ENV || "development"}`)
    console.log(`🔗 API Base URL: ${API_BASE_URL}`)
  })
}

startServer()

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error)
  process.exit(1)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
  process.exit(1)
})



