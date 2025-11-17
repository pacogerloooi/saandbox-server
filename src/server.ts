import http from "http";
import { Server as IOServer, Socket } from "socket.io";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  action : string;
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

/* ======= Config ======= */

const PORT = Number(process.env.PORT || 3000);

let dynamicConfig = {
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:8000",
  apiKey: process.env.API_KEY || "",
};

const roomKeyToId = new Map<string, number | string>();

const httpServer = http.createServer((req, res) => {
  // Serve config panel HTML
  if (req.method === "GET" && req.url === "/config") {
    const htmlPath = path.join(__dirname, "public", "config.html");
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error loading config panel");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  // Get current config
  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dynamicConfig));
    return;
  }

  // Update config
  if (req.method === "POST" && req.url === "/api/config") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const newConfig = JSON.parse(body);
        if (newConfig.apiBaseUrl) dynamicConfig.apiBaseUrl = newConfig.apiBaseUrl;
        if (newConfig.apiKey !== undefined) dynamicConfig.apiKey = newConfig.apiKey;
        
        console.log("✅ Configuración actualizada:", dynamicConfig);
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, config: dynamicConfig }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
      }
    });
    return;
  }

  // Default response
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Socket.IO Server - Visit /config to configure");
});

const io = new IOServer(httpServer, {
  connectionStateRecovery: {},
  cors: { origin: "*", methods: ["GET", "POST"] },
});

/* ======= Helpers ======= */

function apiHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (dynamicConfig.apiKey) headers["Authorization"] = `Bearer ${dynamicConfig.apiKey}`;
  return headers;
}

async function createRoomOnApi(payload: CreateRoomPayload): Promise<ApiRoom> {
  try {
    const resp = await axios.post<ApiRoom>(`${dynamicConfig.apiBaseUrl}/rooms`, payload, {
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
    .post(`${dynamicConfig.apiBaseUrl}/rooms/${roomId}/messages`, message, {
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

async function createAction(payload: CheckoutInitiatedPayload){
  try {
    await axios.post(`${dynamicConfig.apiBaseUrl}/actions`, payload, {
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
  io.emit("heartbeat", { time: Date.now() });
}, 20000);

httpServer.listen(PORT, () => {
  console.log(`🚀 Socket.IO escuchando en ${PORT}`);
  console.log(`🌐 API_BASE_URL=${dynamicConfig.apiBaseUrl}`);
  console.log(`⚙️  Panel de configuración: http://localhost:${PORT}/config`);
});
