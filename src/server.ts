import { createServer } from 'http'
import { Server as IOServer, type Socket } from 'socket.io'
import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const PORT = Number(process.env.PORT || 3004)
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000'
const API_KEY = process.env.API_KEY || ''

interface LogEntry {
  timestamp: string
  level: 'info' | 'error' | 'warn'
  message: string
  data?: any
}

const logBuffer: LogEntry[] = []
const MAX_LOGS = 1000 // Mantener últimos 1000 logs

function addLog (level: LogEntry['level'], message: string, data?: any) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data
  }

  logBuffer.push(entry)

  // Mantener buffer circular
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.shift()
  }

  // También imprimir en consola real
  const logMessage = `[${entry.timestamp}] [${level.toUpperCase()}] ${message}`
  if (level === 'error') {
    console.error(logMessage, data || '')
  } else if (level === 'warn') {
    console.warn(logMessage, data || '')
  } else {
    console.log(logMessage, data || '')
  }
}

const httpServer = createServer((req, res) => {
  if (req.url === '/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify(
        {
          total: logBuffer.length,
          logs: logBuffer
        },
        null,
        2
      )
    )
    return
  }

  if (req.url === '/logs/console' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    const consoleOutput = logBuffer
      .map(log => {
        const dataStr = log.data ? ` | ${JSON.stringify(log.data)}` : ''
        return `[${log.timestamp}] [${log.level.toUpperCase()}] ${
          log.message
        }${dataStr}`
      })
      .join('\n')
    res.end(consoleOutput)
    return
  }

  if (req.url === '/logs/clear' && req.method === 'POST') {
    const count = logBuffer.length
    logBuffer.length = 0
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Logs cleared', cleared: count }))
    return
  }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

const io = new IOServer(httpServer, {
  connectionStateRecovery: {},
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

type Sender = 'user' | 'agent'

interface Room {
  id: number
  agent_name: string
  user_name: string
  status: 'open' | 'closed'
}
interface ActionPayload {
  action: string
  description?: string
  [key: string]: any
}

interface Message {
  content: string
  sender: Sender
  timestamp?: string
}

function apiHeaders () {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }

  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`
  }

  return headers
}

function saveMessageAsync (roomId: number, message: Message) {
  axios
    .post(`${API_BASE_URL}/room/messages/${roomId}`, message, {
      headers: apiHeaders()
    })
    .catch(err => {
      addLog(
        'error',
        `Error guardando mensaje en room ${roomId}`,
        err?.response?.data || err?.message
      )
    })
}

io.on('connection', (socket: Socket) => {
  addLog('info', `Cliente conectado: ${socket.id}`)

  socket.on('room:join', ({ room }: { room: Room }) => {
    const roomName = `room:${room.id}`

    socket.join(roomName)

    socket.emit('room:joined', { room })

    addLog('info', `Socket ${socket.id} unido a ${roomName}`)
  })

  socket.on(
    'room:message',
    ({
      roomId,
      content,
      sender,
      timestamp
    }: {
      roomId: number
      content: string
      sender: Sender
      timestamp?: string
    }) => {
      const roomName = `room:${roomId}`
      const now = new Date()
      const timeString = now.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit'
      })

      const message: Message = {
        content,
        sender,
        timestamp: timeString
      }

      socket.to(roomName).emit('room:message', message)

      saveMessageAsync(roomId, message)
    }
  )

  socket.on(
    'room:typing:start',
    ({ roomId, sender }: { roomId: number; sender: Sender }) => {
      socket.to(`room:${roomId}`).emit('room:typing:start', { sender })
    }
  )

  socket.on(
    'room:typing:stop',
    ({ roomId, sender }: { roomId: number; sender: Sender }) => {
      socket.to(`room:${roomId}`).emit('room:typing:stop', { sender })
    }
  )

  const actionEvents = [
    'checkout_initiated',
    'checkout_completed',
    'user_viewing_product',
    'user_left_product',
    'order_paid'
  ]

  actionEvents.forEach(eventName => {
    socket.on(eventName, (payload: ActionPayload) => {
      const { room_id, ...eventData } = payload
      if (room_id) {
        io.to(String(room_id)).emit(eventName, eventData)
        addLog('info', `Evento ${eventName} emitido a sala ${room_id}`)
      } else {
        io.emit(eventName, payload)
        addLog('info', `Evento ${eventName} emitido globalmente`)
      }
    })
  })

  socket.on('disconnect', () => {
    addLog('warn', `Cliente desconectado: ${socket.id}`)
  })
})

setInterval(() => {
  io.emit('heartbeat', { time: Date.now() })
  addLog('info', `Heartbeat emitido: ${new Date().toISOString()}`)
}, 40000)

async function startServer () {
  httpServer.listen(PORT, () => {
    addLog('info', `Socket.IO server corriendo en puerto ${PORT}`)
    addLog('info', `WebSocket endpoint: ws://localhost:${PORT}`)
    addLog('info', `Health check: http://localhost:${PORT}/health`)
    addLog('info', `Logs JSON: http://localhost:${PORT}/logs`)
    addLog('info', `Logs Console: http://localhost:${PORT}/logs/console`)
    addLog('info', `Entorno: ${process.env.NODE_ENV || 'development'}`)
    addLog('info', `API Base URL: ${API_BASE_URL}`)
  })
}

startServer()

process.on('uncaughtException', error => {
  addLog('error', 'Uncaught Exception', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  addLog('error', 'Unhandled Rejection', { reason, promise })
  process.exit(1)
})
