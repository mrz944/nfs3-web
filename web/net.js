// Online play, page side: joins a room on the relay (web/relay.mjs), connects
// to every other member directly with WebRTC data channels, and carries the
// game's IPX packets (runtime/net.c) between them. Packets go peer-to-peer when
// the direct channel is open and through the relay otherwise.
//
// Wire format between pages (data channel): the game packet as is (the sender
// is known from the channel). Through the relay: [dst node 6][packet] out,
// [src node 6][packet] in.

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const BCAST = 'ffffffffffff';
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));

export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null; this.id = null; this.room = null;
    this.peers = new Map();      // id -> { name, pc, dc, rtt, direct }
    this.mod = null; this.queue = [];
    this.relayRtt = null;
  }

  // ------------------------------------------------------------- lobby
  join(room, name) {
    return new Promise((resolve, reject) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/net`;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('The online server did not answer.')), 8000);
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach the online server.')); };
      ws.onclose = () => { this.emit('status'); if (this.id) this.emit('log', 'disconnected from the online server'); };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') { this.fromRelay(new Uint8Array(ev.data)); return; }
        const m = JSON.parse(ev.data);
        if (m.t === 'welcome') {
          clearTimeout(timer);
          this.id = m.id; this.room = m.room;
          for (const p of m.peers) this.addPeer(p.id, p.name, true);   // we are the newcomer: we call them
          this.emit('status'); resolve(m);
          this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
        } else if (m.t === 'error') { clearTimeout(timer); reject(new Error(m.error)); }
        else if (m.t === 'join') { this.addPeer(m.id, m.name, false); this.emit('log', `${m.name} joined the room`); this.emit('status'); }
        else if (m.t === 'leave') { const p = this.peers.get(m.id); if (p) { p.pc?.close(); this.peers.delete(m.id); this.emit('log', `${p.name} left`); this.emit('status'); } }
        else if (m.t === 'signal') this.onSignal(m.from, m.data);
        else if (m.t === 'pong') { this.relayRtt = performance.now() - m.ts; this.emit('status'); }
      };
      ws.onopen = () => this.send({ t: 'hello', room, name });
    });
  }
  send(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ------------------------------------------------------------ WebRTC
  addPeer(id, name, initiator) {
    const p = { name, pc: new RTCPeerConnection({ iceServers: ICE }), dc: null, rtt: null, direct: false };
    this.peers.set(id, p);
    p.pc.onicecandidate = (e) => { if (e.candidate) this.send({ t: 'signal', to: id, data: { ice: e.candidate } }); };
    p.pc.onconnectionstatechange = () => { if (p.pc.connectionState === 'failed') this.emit('log', `no direct connection to ${name}, using the relay`); this.emit('status'); };
    const setup = (dc) => {
      p.dc = dc; dc.binaryType = 'arraybuffer';
      dc.onopen = () => { p.direct = true; this.emit('log', `direct connection to ${name}`); this.emit('status'); };
      dc.onclose = () => { p.direct = false; this.emit('status'); };
      dc.onmessage = (ev) => this.deliver(id, new Uint8Array(ev.data));
    };
    if (initiator) {
      // unordered, lost packets retried by WebRTC for up to 150 ms (much faster than the game's own resend)
      setup(p.pc.createDataChannel('ipx', { ordered: false, maxPacketLifeTime: 150 }));
      p.pc.createOffer().then((o) => p.pc.setLocalDescription(o)).then(() => this.send({ t: 'signal', to: id, data: { sdp: p.pc.localDescription } }));
    } else {
      p.pc.ondatachannel = (e) => setup(e.channel);
    }
    p.statsTimer = setInterval(async () => {
      if (!p.direct) return;
      const stats = await p.pc.getStats();
      stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) p.rtt = s.currentRoundTripTime * 1000; });
      this.emit('status');
    }, 2000);
  }
  async onSignal(from, data) {
    let p = this.peers.get(from);
    if (!p) return;
    if (data.sdp) {
      await p.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        this.send({ t: 'signal', to: from, data: { sdp: p.pc.localDescription } });
      }
    } else if (data.ice) { try { await p.pc.addIceCandidate(data.ice); } catch {} }
  }

  // ----------------------------------------------------------- packets
  attach(mod) {
    this.mod = mod;
    // called (on this thread) by runtime/net.c for every packet the game sends: [dst 6][packet]
    mod.netSend = (ptr, len) => {
      const buf = mod.HEAPU8.slice(ptr, ptr + len); mod._free(ptr);
      const dst = hex(buf.subarray(0, 6)), pkt = buf.subarray(6);
      if (dst === BCAST) { for (const id of this.peers.keys()) this.sendTo(id, pkt); }
      else this.sendTo(dst, pkt);
    };
    for (const [src, pkt] of this.queue) this.deliver(src, pkt);
    this.queue = [];
  }
  sendTo(id, pkt) {
    const p = this.peers.get(id);
    if (p?.dc?.readyState === 'open') { try { p.dc.send(pkt); return; } catch {} }
    if (this.ws?.readyState === 1) { const f = new Uint8Array(6 + pkt.length); f.set(unhex(id)); f.set(pkt, 6); this.ws.send(f); }
  }
  fromRelay(f) { if (f.length > 6) this.deliver(hex(f.subarray(0, 6)), f.subarray(6)); }
  deliver(srcId, pkt) {
    const mod = this.mod;
    if (!mod) { this.queue.push([srcId, pkt]); return; }
    const n = 6 + pkt.length, p = mod._malloc(n);
    mod.HEAPU8.set(unhex(srcId), p); mod.HEAPU8.set(pkt, p + 6);
    mod._rt_net_packet(p, n);
    mod._free(p);
  }

  summary() {
    const list = [...this.peers.values()].map((p) =>
      `${p.name}: ${p.direct ? (p.rtt != null ? Math.round(p.rtt) + ' ms direct' : 'direct') : 'relay' + (this.relayRtt != null ? ' ~' + Math.round(this.relayRtt * 2) + ' ms' : '')}`);
    return { room: this.room, players: this.peers.size + 1, peers: list };
  }
}

export function newRoomCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => a[b % a.length]).join('');
}
