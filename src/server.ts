import { createServer } from "http"
import { Server as IOServer, Socket } from "socket.io";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

interface ApiRoom {
  id: number | string;
  room_key: string;
  created_at: string;
}

interface CreateRoomPayload {
  room_key: string;
  user_name: string;
  status: string;
}

interface Message {
  sender: "user" | "agent";
  sender_id: string | null;
  content: string;
}

interface CreateOrSendPayload {
  user_name: string;
  content: string;
  sender: "user" | "agent";
  sender_id: string | null;
}

interface SendMessagePayload {
  room_id?: number | string;
  room_key?: string;
  content: string;
  sender?: "user" | "agent";
  sender_id?: string | null;
}

export interface CheckoutInitiatedPayload {
  action: string;
  description: string;
}

interface JoinRoomPayload {
  room_id?: number | string;
  room_key?: string;
}

interface ActionPayload {
  action: string;
  description?: string;
}

interface TypingPayload {
  room_id?: number | string;
  room_key?: string;
  user_id: string;
  user_name: string;
}

interface StopTypingPayload {
  room_id?: number | string;
  room_key?: string;
  user_id: string;
}

const PORT = Number(process.env.PORT || 3000);
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
const API_KEY = process.env.API_KEY || "";

const roomKeyToId = new Map<string, number | string>();

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
    methods: ["GET", "POST"]
  }
});

function apiHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  return headers;
}

async function createRoomOnApi(payload: CreateRoomPayload): Promise<ApiRoom> {
  try {
    const resp = await axios.post<ApiRoom>(`${API_BASE_URL}/rooms`, payload, {
      headers: apiHeaders(),
    });
    return resp.data;
  } catch (err) {
    const e = err as any;
    console.error(
      "❌ Error creando sala:",
      e?.response?.data || e?.message || e
    );
    throw e;
  }
}

function saveMessageAsync(roomId: number | string, message: Message) {
  axios
    .post(`${API_BASE_URL}/rooms/${roomId}/messages`, message, {
      headers: apiHeaders(),
    })
    .catch((err) => {
      const e = err as any;
      console.error(
        `❌ Error guardando mensaje en room ${roomId}:`,
        e?.response?.data || e?.message || e
      );
    });
}

async function createAction(payload: CheckoutInitiatedPayload) {
  try {
    await axios.post(`${API_BASE_URL}/actions`, payload, {
      headers: apiHeaders(),
    });
  } catch (err) {
    const e = err as any;
    console.error(
      "❌ Error creando acción:",
      e?.response?.data || e?.message || e
    );
    throw e;
  }
}

function resolveRoomId(room_id?: number | string, room_key?: string) {
  return room_id || (room_key ? roomKeyToId.get(room_key) : undefined);
}

io.on("connection", (socket: Socket) => {
  console.log(`⚡ Cliente conectado: ${socket.id}`);

  /* Crear sala + primer mensaje */
  socket.on("create_or_send", async (payload: CreateOrSendPayload) => {
    const { user_name, content, sender, sender_id } = payload;
    const room_key = `room_${uuidv4().split("-")[0]}`;

    const createPayload: CreateRoomPayload = {
      room_key,
      user_name,
      status: "open",
    };

    try {
      const apiRoom = await createRoomOnApi(createPayload);
      const roomId = apiRoom.id;

      roomKeyToId.set(room_key, roomId);
      socket.join(String(roomId));

      socket.emit("room_created", {
        room_id: roomId,
        room_key,
        created_at: apiRoom.created_at,
      });

      const msg: Message = { sender, sender_id, content };

      io.to(String(roomId)).emit("new_message", msg);

      saveMessageAsync(roomId, msg);
    } catch {
      socket.emit("error_creating_room", {
        message: "No se pudo crear la sala",
      });
    }
  });

  /* Enviar mensaje */
  socket.on("send_message", (payload: SendMessagePayload) => {
    const {
      room_id,
      room_key,
      content,
      sender = "user",
      sender_id = null,
    } = payload;

    const resolvedRoomId = resolveRoomId(room_id, room_key);
    if (!resolvedRoomId) {
      socket.emit("error", { message: "room_id o room_key requerido" });
      return;
    }

    const msg: Message = { sender, sender_id, content };

    io.to(String(resolvedRoomId)).emit("new_message", msg);
    saveMessageAsync(resolvedRoomId, msg);
  });

  /* Typing */
  socket.on("user_typing", (payload: TypingPayload) => {
    const resolvedRoomId = resolveRoomId(payload.room_id, payload.room_key);
    if (!resolvedRoomId) return;

    socket.to(String(resolvedRoomId)).emit("user_typing", {
      ...payload,
      room_id: resolvedRoomId,
    });
  });

  socket.on("user_stop_typing", (payload: StopTypingPayload) => {
    const resolvedRoomId = resolveRoomId(payload.room_id, payload.room_key);
    if (!resolvedRoomId) return;

    socket.to(String(resolvedRoomId)).emit("user_stop_typing", {
      ...payload,
      room_id: resolvedRoomId,
      timestamp: new Date().toISOString(),
    });
  });

  /* Unirse a sala */
  socket.on("join_room", (payload: JoinRoomPayload) => {
    const resolvedRoomId = resolveRoomId(payload.room_id, payload.room_key);

    if (!resolvedRoomId) {
      socket.emit("error", {
        message: "room_id o room_key requerido para unirse",
      });
      return;
    }

    socket.join(String(resolvedRoomId));
    socket.emit("joined_room", { room_id: resolvedRoomId });
  });

  socket.on("checkout_initiated", (payload: CheckoutInitiatedPayload) => {
    try {
      createAction(payload);
      console.log("✅ Acción guardada correctamente");
    } catch (err: any) {
      console.error("❌ Error al guardar acción:", err.response?.data);
    }

    io.emit("checkout_initiated", payload);
  });

  socket.on("checkout_completed", (payload) => {
    io.emit("checkout_completed", payload);
  });

  socket.on("user_viewing_product", (payload) => {
    io.emit("user_viewing_product", payload);
  });

  socket.on("user_left_product", (payload) => {
    io.emit("user_left_product", payload);
  });

  socket.on("order_paid", (payload) => {
    io.emit("order_paid", payload);
  });

  socket.on("disconnect", () => {
    console.log(`⚠️ Cliente desconectado: ${socket.id}`);
  });
});

setInterval(() => {
  io.emit("heartbeat", { time: Date.now() })
  console.log("💓 Heartbeat emitted:", new Date().toISOString())
}, 40000)

httpServer.listen(PORT, () => {
  console.log(`🚀 Socket.IO server running on port ${PORT}`)
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`)
  console.log(`🏥 Health check: http://localhost:${PORT}/health`)
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`)
  console.log(`🔗 API Base URL: ${API_BASE_URL}`)
})

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error)
  process.exit(1)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
  process.exit(1)
})

