import { Readable } from 'node:stream';
import OpusScript from 'opusscript';

export const FRAME_BYTES = 960 * 2 * 2; // 20 ms, 48 kHz, stereo, signed 16-bit LE.
const SILENCE = Buffer.alloc(FRAME_BYTES);

export class PcmQueue {
  frames = [];
  received = 0;
  nonSilent = 0;
  dropped = 0;
  underruns = 0;
  primed = false;
  constructor(maxFrames = 12, { prebufferFrames = 4 } = {}) {
    this.maxFrames = maxFrames;
    this.prebufferFrames = Math.min(maxFrames, prebufferFrames);
  }
  accept(base64) {
    if (typeof base64 !== 'string' || base64.length < FRAME_BYTES / 3 * 4 ||
        base64.length > FRAME_BYTES / 3 * 4 * 4) return false;
    const batch = Buffer.from(base64, 'base64');
    if (batch.length % FRAME_BYTES || batch.length < FRAME_BYTES || batch.length > FRAME_BYTES * 4) return false;
    for (let offset = 0; offset < batch.length; offset += FRAME_BYTES) {
      const frame = batch.subarray(offset, offset + FRAME_BYTES);
      this.received++;
      if (frame.some(byte => byte !== 0)) this.nonSilent++;
      if (this.frames.length >= this.maxFrames) { this.frames.shift(); this.dropped++; }
      this.frames.push(frame);
    }
    return true;
  }
  next() {
    // Hold 80 ms before playing so uneven browser delivery does not insert gaps.
    if (!this.primed) {
      if (this.frames.length < this.prebufferFrames) return SILENCE;
      this.primed = true;
    }
    if (!this.frames.length) {
      this.underruns++;
      this.primed = false;
      return SILENCE;
    }
    return this.frames.shift();
  }
  clear() { this.frames.length = 0; this.primed = false; }
}

// Sum two 20 ms PCM frames sample-by-sample with clamping, so the user hears
// both strangers at once (not one after the other).
function mixFrames(a, b) {
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    let s = a.readInt16LE(i) + b.readInt16LE(i);
    if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
    out.writeInt16LE(s, i);
  }
  return out;
}

// Two independent inbound PcmQueues (stranger A, stranger B) mixed into one
// real-time stream for Discord. Each 20 ms pull sums one frame from each side.
export class MixQueue {
  constructor(maxFrames = 12, opts = {}) {
    this.q1 = new PcmQueue(maxFrames, opts);
    this.q2 = new PcmQueue(maxFrames, opts);
  }
  accept1(base64) { return this.q1.accept(base64); }
  accept2(base64) { return this.q2.accept(base64); }
  next() { return mixFrames(this.q1.next(), this.q2.next()); }
  clear() { this.q1.clear(); this.q2.clear(); }
  get received() { return this.q1.received + this.q2.received; }
  get nonSilent() { return this.q1.nonSilent + this.q2.nonSilent; }
  get dropped() { return this.q1.dropped + this.q2.dropped; }
  get underruns() { return this.q1.underruns + this.q2.underruns; }
  get frames() { return { length: this.q1.frames.length + this.q2.frames.length }; }
}

export class RelayOpusStream extends Readable {
  constructor(queue, { bitrate = 64000 } = {}) {
    // Discord reads one packet each 20 ms. Avoid a second drifting timer and
    // the raw PCM transform's large packet backlog; keep just one packet ahead.
    super({ objectMode: true, highWaterMark: 1 });
    this.queue = queue;
    this.encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    this.encoder.setBitrate(Math.max(16000, Math.min(96000, bitrate)));
    this.encoder.encoderCTL(4012, 1); // Opus in-band forward error correction.
    this.encoder.encoderCTL(4014, 10); // Allow for up to 10% outbound packet loss.
  }
  _read() {
    try { this.push(this.encoder.encode(this.queue.next(), 960)); }
    catch (error) { this.destroy(error); }
  }
  _destroy(error, done) {
    this.encoder?.delete();
    this.encoder = null;
    done(error);
  }
}
