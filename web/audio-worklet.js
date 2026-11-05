// Drains the runtime's audio ring (interleaved s16 stereo in shared wasm memory).
// Ring layout (dsound.c WebAudio): u32 rd, u32 wr, u32 cap, u32 rate, s16 data[2*cap]
class RingPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.port.onmessage = (e) => {
      const { buffer, ptr } = e.data;
      this.u32 = new Uint32Array(buffer, ptr, 4);
      this.cap = this.u32[2];
      this.pcm = new Int16Array(buffer, ptr + 16, 2 * this.cap);
      this.ready = true;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    if (!this.ready) { L.fill(0); if (R !== L) R.fill(0); return true; }
    let rd = Atomics.load(this.u32, 0);
    const wr = Atomics.load(this.u32, 1), mask = this.cap - 1;
    for (let i = 0; i < L.length; i++) {
      if (rd === wr) { L[i] = 0; R[i] = 0; continue; }       // underrun: silence
      const j = (rd & mask) * 2;
      L[i] = this.pcm[j] / 32768; R[i] = this.pcm[j + 1] / 32768;
      rd = (rd + 1) >>> 0;
    }
    Atomics.store(this.u32, 0, rd);
    return true;
  }
}
registerProcessor('ring-player', RingPlayer);
