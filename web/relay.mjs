// Lobby + packet relay for online play. No dependencies.
//
// A room is a virtual LAN. Each member gets a 6-byte node address (the IPX
// node number the game sees). Browsers then try to connect to each other
// directly over WebRTC (signalling goes through here); packets between peers
// that can't connect directly are relayed by this server.
//
// Transports:
//   WebSocket  GET /net            browsers
//   raw TCP    (optional port)     native test builds: frames = u32 len | u8 kind | body
// Messages (kind 0 = JSON text, kind 1 = binary packet):
//   -> {t:'hello', room, name}            <- {t:'welcome', id, room, peers:[{id,name}]}
//   <- {t:'join', id, name} / {t:'leave', id}
//   -> {t:'signal', to, data}             <- {t:'signal', from, data}      (WebRTC)
//   -> {t:'ping', ts}                     <- {t:'pong', ts}
//   -> binary [dst node 6][payload]       <- binary [src node 6][payload]  (dst ff.. = everyone)
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { rmSync } from 'node:fs';

const rooms = new Map();         // room name -> Map(idHex -> client)
const MAX_ROOM = 8;              // NFS3 races take up to 8 players
const BCAST = 'ffffffffffff';

function roomOf(name) {
  if (!rooms.has(name)) rooms.set(name, new Map());
  return rooms.get(name);
}
function newId(room) {
  for (;;) {
    const id = '02' + '00' + randomBytes(4).toString('hex');   // locally administered, never broadcast
    if (!room.has(id)) return id;
  }
}

class Client {
  constructor(sendText, sendBin, close, label) {
    this.sendText = sendText; this.sendBin = sendBin; this.close = close; this.label = label;
    this.id = null; this.room = null; this.name = '';
  }
  json(o) { this.sendText(JSON.stringify(o)); }
  onText(s) {
    let m; try { m = JSON.parse(s); } catch { return; }
    if (m.t === 'hello' && !this.id) {
      const roomName = String(m.room || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
      if (!roomName) return this.json({ t: 'error', error: 'no room' });
      const room = roomOf(roomName);
      if (room.size >= MAX_ROOM) return this.json({ t: 'error', error: 'room full' });
      this.room = roomName; this.name = String(m.name || 'player').slice(0, 24); this.id = newId(room);
      const peers = [...room.values()].map((c) => ({ id: c.id, name: c.name }));
      room.set(this.id, this);
      this.json({ t: 'welcome', id: this.id, room: roomName, peers });
      for (const c of room.values()) if (c !== this) c.json({ t: 'join', id: this.id, name: this.name });
      console.log(`[relay] ${this.label} joined ${roomName} as ${this.id} (${this.name}), ${room.size} in room`);
    } else if (m.t === 'signal' && this.id) {
      const peer = rooms.get(this.room)?.get(m.to);
      if (peer) peer.json({ t: 'signal', from: this.id, data: m.data });
    } else if (m.t === 'ping') {
      this.json({ t: 'pong', ts: m.ts });
    }
  }
  onBin(buf) {
    if (!this.id || buf.length < 7) return;
    const room = rooms.get(this.room); if (!room) return;
    const dst = buf.subarray(0, 6).toString('hex');
    const out = Buffer.allocUnsafe(buf.length);
    Buffer.from(this.id, 'hex').copy(out, 0); buf.copy(out, 6, 6);
    if (dst === BCAST) { for (const c of room.values()) if (c !== this) c.sendBin(out); }
    else room.get(dst)?.sendBin(out);
  }
  gone() {
    if (!this.id) return;
    const room = rooms.get(this.room); if (!room) return;
    room.delete(this.id);
    for (const c of room.values()) c.json({ t: 'leave', id: this.id });
    if (!room.size) rooms.delete(this.room);
    console.log(`[relay] ${this.id} left ${this.room}`);
    this.id = null;
  }
}

// ---------------------------------------------------------------- WebSocket
export function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const frame = (op, data) => {
    const n = data.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    if (!socket.destroyed) socket.write(Buffer.concat([head, data]));
  };
  const client = new Client((s) => frame(1, Buffer.from(s)), (b) => frame(2, b), () => socket.destroy(),
                            req.socket.remoteAddress);
  let acc = Buffer.alloc(0), frag = [], fragOp = 0;
  socket.on('data', (d) => {
    acc = Buffer.concat([acc, d]);
    for (;;) {
      if (acc.length < 2) return;
      const fin = acc[0] & 0x80, op = acc[0] & 15, masked = acc[1] & 0x80;
      let len = acc[1] & 127, off = 2;
      if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { socket.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (acc.length < need) return;
      let payload = acc.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = acc.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      acc = acc.subarray(need);
      if (op === 8) { socket.end(); return; }
      if (op === 9) { frame(10, payload); continue; }
      if (op === 10) continue;
      if (op) fragOp = op;
      frag.push(payload);
      if (!fin) continue;
      const msg = Buffer.concat(frag); const kind = fragOp; frag = [];
      if (kind === 1) client.onText(msg.toString()); else client.onBin(msg);
    }
  });
  socket.on('close', () => client.gone());
  socket.on('error', () => client.gone());
}

// --------------------------------------------------- raw TCP (native builds)
export function listenRaw(port, host = '127.0.0.1') {
  // port may be a number (TCP on host) or a filesystem path (Unix socket)
  const isPath = typeof port === 'string' && port.includes('/');
  if (isPath) rmSync(port, { force: true });
  createTcpServer((sock) => {
    sock.setNoDelay(true);
    const send = (kind, body) => { const h = Buffer.alloc(5); h.writeUInt32LE(body.length + 1, 0); h[4] = kind; if (!sock.destroyed) sock.write(Buffer.concat([h, body])); };
    const client = new Client((s) => send(0, Buffer.from(s)), (b) => send(1, b), () => sock.destroy(), 'native:' + (sock.remotePort || 'unix'));
    let acc = Buffer.alloc(0);
    sock.on('data', (d) => {
      acc = Buffer.concat([acc, d]);
      while (acc.length >= 4) {
        const n = acc.readUInt32LE(0);
        if (n < 1 || n > 1 << 20) { sock.destroy(); return; }
        if (acc.length < 4 + n) break;
        const kind = acc[4], body = acc.subarray(5, 4 + n); acc = acc.subarray(4 + n);
        if (kind === 0) client.onText(body.toString()); else client.onBin(Buffer.from(body));
      }
    });
    sock.on('close', () => client.gone());
    sock.on('error', () => client.gone());
  }).listen(...(isPath ? [port] : [port, host]), () => console.log(`[relay] native clients: ${isPath ? 'unix:' + port : `tcp://${host}:${port}`}`));
}

export function roomStats() {
  return [...rooms.entries()].map(([name, r]) => ({ room: name, players: r.size }));
}
