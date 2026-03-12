import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.PORT || '8787', 10);
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function originAllowed(origin) {
  if (ALLOW_ORIGINS.includes('*')) return true;
  if (!origin) return false;
  return ALLOW_ORIGINS.includes(origin);
}

/**
 * In-memory state only (no DB).
 *
 * rooms: Map<roomHash, Map<peerId, ws>>
 */
const rooms = new Map();

function getRoom(roomHash) {
  let room = rooms.get(roomHash);
  if (!room) {
    room = new Map();
    rooms.set(roomHash, room);
  }
  return room;
}

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(roomHash, msg, exceptPeerId = null) {
  const room = rooms.get(roomHash);
  if (!room) return;
  for (const [peerId, ws] of room.entries()) {
    if (exceptPeerId && peerId === exceptPeerId) continue;
    safeSend(ws, msg);
  }
}

const server = http.createServer((req, res) => {
  // Minimal health endpoint for platforms.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    ws.close(1008, 'origin not allowed');
    return;
  }

  ws._peerId = null;
  ws._roomHash = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      const { roomHash, peerId, client } = msg;
      if (typeof roomHash !== 'string' || roomHash.length < 8) return;
      if (typeof peerId !== 'string' || peerId.length < 8) return;

      // If already registered, ignore.
      if (ws._peerId) return;

      ws._peerId = peerId;
      ws._roomHash = roomHash;
      ws._client = typeof client === 'string' ? client : 'unknown';

      const room = getRoom(roomHash);
      if (room.has(peerId)) {
        // PeerId collision; ask client to rotate.
        safeSend(ws, { type: 'error', code: 'PEER_ID_TAKEN' });
        ws.close(1011, 'peerId taken');
        return;
      }

      // Snapshot peers *before* adding.
      const peers = Array.from(room.keys());
      room.set(peerId, ws);

      safeSend(ws, { type: 'welcome', peerId, roomHash, peers });
      broadcast(roomHash, { type: 'peer-joined', peerId }, peerId);
      return;
    }

    // Everything else requires registration.
    if (!ws._peerId || !ws._roomHash) return;

    if (msg.type === 'signal') {
      const { to, data } = msg;
      if (typeof to !== 'string' || !data || typeof data !== 'object') return;
      const room = rooms.get(ws._roomHash);
      const dest = room?.get(to);
      if (!dest) return;
      safeSend(dest, {
        type: 'signal',
        from: ws._peerId,
        data
      });
      return;
    }

    if (msg.type === 'ping') {
      safeSend(ws, { type: 'pong', t: Date.now() });
      return;
    }
  });

  ws.on('close', () => {
    const peerId = ws._peerId;
    const roomHash = ws._roomHash;
    if (!peerId || !roomHash) return;
    const room = rooms.get(roomHash);
    if (!room) return;
    room.delete(peerId);
    broadcast(roomHash, { type: 'peer-left', peerId }, peerId);
    if (room.size === 0) rooms.delete(roomHash);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[open-radio signaling] listening on :${PORT}`);
});

