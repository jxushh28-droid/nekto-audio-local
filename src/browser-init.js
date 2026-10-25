// Serialized by Playwright and run before the site's scripts.
// injectMic: when true, nekto's outgoing microphone is driven by audio pushed
// from Node via window.__injectMic (used to feed the OTHER stranger's voice in
// the two-window bridge). getUserMedia is Proxy-overridden (native-code-safe)
// to return our injected stream instead of the fake capture device.
export function installBrowserRelay({ origin, injectMic = false }) {
  if (location.origin !== origin) return;
  const audio = new AudioContext({ sampleRate: 48000 });
  const mix = audio.createGain();
  // Outgoing-mic injection plumbing (only wired when injectMic is set).
  const micDest = injectMic ? audio.createMediaStreamDestination() : null;
  let micNode = null;
  window.__injectMic = (b64) => {
    if (!micNode) return false;
    try {
      const bin = atob(b64); const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const samples = (len / 4) | 0; // interleaved stereo int16 → 4 bytes per frame
      const left = new Float32Array(samples), right = new Float32Array(samples);
      for (let i = 0; i < samples; i++) { left[i] = view.getInt16(i * 4, true) / 32768; right[i] = view.getInt16(i * 4 + 2, true) / 32768; }
      micNode.port.postMessage({ left, right }, [left.buffer, right.buffer]);
      return true;
    } catch { return false; }
  };
  if (injectMic && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    // Proxy keeps Function.prototype.toString === "[native code]" so nekto's
    // native-code tamper check passes. Audio requests get our injected stream;
    // anything else is forwarded to the real getUserMedia untouched.
    const handler = {
      apply(target, thisArg, args) {
        const c = args[0] || {};
        if (c.audio && micDest) {
          return Promise.resolve(new MediaStream(micDest.stream.getAudioTracks()));
        }
        return Reflect.apply(target, thisArg, args);
      },
    };
    try { navigator.mediaDevices.getUserMedia = new Proxy(navigator.mediaDevices.getUserMedia, handler); } catch {}
  }
  const tracks = new Map();
  const peers = new Set();
  const pendingTracks = new Set();
  window.__nektoRelay = { tracks: 0, trackEvents: 0, frames: 0, droppedFrames: 0, error: null, bindingErrors: 0,
    peers: 0, peerStates: [], iceStates: [], inboundPackets: 0, inboundBytes: 0, audioState: audio.state };
  audio.addEventListener('statechange', () => { window.__nektoRelay.audioState = audio.state; });
  let pending = 0;
  const send = (buffer) => {
    if (!tracks.size) return;
    if (pending >= 6) { window.__nektoRelay.droppedFrames += buffer.byteLength / 3840; return; }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    pending++;
    window.pushNektoAudio(btoa(binary))
      .then(() => { window.__nektoRelay.frames += buffer.byteLength / 3840; })
      .catch(() => { window.__nektoRelay.bindingErrors++; })
      .finally(() => { pending--; });
  };
  const processorCode = `
    class Relay extends AudioWorkletProcessor {
      constructor() { super(); this.frame = new ArrayBuffer(7680); this.view = new DataView(this.frame); this.offset = 0; }
      process(inputs) {
        const channels = inputs[0];
        if (!channels?.[0]) return true;
        const left = channels[0]; const right = channels[1] || left;
        for (let i = 0; i < left.length; i++) {
          const l = Math.max(-1, Math.min(1, left[i]));
          const r = Math.max(-1, Math.min(1, right[i]));
          this.view.setInt16(this.offset, Math.round(l * (l < 0 ? 32768 : 32767)), true);
          this.view.setInt16(this.offset + 2, Math.round(r * (r < 0 ? 32768 : 32767)), true);
          this.offset += 4;
          if (this.offset === 7680) {
            this.port.postMessage(this.frame, [this.frame]);
            this.frame = new ArrayBuffer(7680); this.view = new DataView(this.frame); this.offset = 0;
          }
        }
        return true;
      }
    }
    registerProcessor('nekto-relay', Relay);
    class Mic extends AudioWorkletProcessor {
      constructor() { super(); this.q = []; this.qLen = 0;
        this.port.onmessage = (e) => { const d = e.data; d.off = 0; this.q.push(d); this.qLen += d.left.length; }; }
      process(_inputs, outputs) {
        const out = outputs[0]; if (!out || !out[0]) return true;
        const L = out[0]; const R = out[1] || null;
        let i = 0;
        while (i < L.length) {
          if (!this.q.length) { for (; i < L.length; i++) { L[i] = 0; if (R) R[i] = 0; } break; }
          const h = this.q[0]; const avail = h.left.length - h.off; const need = L.length - i;
          const n = avail < need ? avail : need;
          for (let k = 0; k < n; k++) { L[i + k] = h.left[h.off + k]; if (R) R[i + k] = h.right ? h.right[h.off + k] : h.left[h.off + k]; }
          h.off += n; i += n; this.qLen -= n;
          if (h.off >= h.left.length) this.q.shift();
        }
        // Cap buffered audio to ~1s so the bridge stays low-latency on overrun.
        while (this.qLen > sampleRate) { const h = this.q.shift(); if (!h) break; this.qLen -= (h.left.length - h.off); }
        return true;
      }
    }
    registerProcessor('nekto-mic', Mic);`;
  const ready = (async () => {
    const url = URL.createObjectURL(new Blob([processorCode], { type: 'application/javascript' }));
    try { await audio.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const processor = new AudioWorkletNode(audio, 'nekto-relay', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    processor.port.onmessage = ({ data }) => send(data);
    mix.connect(processor);
    processor.connect(audio.destination); // Worklet output is silence; keeps the graph rendering.
    if (injectMic && micDest) {
      micNode = new AudioWorkletNode(audio, 'nekto-mic', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      micNode.connect(micDest);
    }
    await audio.resume();
  })();
  ready.catch(() => { window.__nektoRelay.error = 'Audio capture initialization failed.'; });

  // Chromium supplies native microphone capture from a silent WAV file.
  // Leave modern and legacy capture APIs, constraints and permissions intact.
  const capture = async (track) => {
    if (track.kind !== 'audio' || tracks.has(track.id) || pendingTracks.has(track.id)) return;
    pendingTracks.add(track.id);
    let playback, source;
    try {
      await ready; await audio.resume();
      if (track.readyState === 'ended' || tracks.has(track.id)) return;
      const stream = new MediaStream([track]);
      // Chromium's WebRTC jitter buffer needs an active media-element sink to start playout.
      playback = document.createElement('audio');
      playback.srcObject = stream;
      playback.autoplay = true;
      playback.volume = 0; // Keep native playout active without a second audible copy on the bot PC.
      await playback.play();
      if (track.readyState === 'ended') { playback.pause(); playback.srcObject = null; return; }
      source = audio.createMediaStreamSource(stream);
      source.connect(mix);
      tracks.set(track.id, { source, playback });
      window.__nektoRelay.tracks = tracks.size;
      track.addEventListener('ended', () => {
        source.disconnect(); playback.pause(); playback.srcObject = null;
        tracks.delete(track.id); window.__nektoRelay.tracks = tracks.size;
      }, { once: true });
    } catch (error) {
      source?.disconnect(); playback?.pause();
      if (playback) playback.srcObject = null;
      throw error;
    } finally { pendingTracks.delete(track.id); }
  };
  const recoverTracks = peer => {
    if (peer.connectionState !== 'connected') return;
    for (const transceiver of peer.getTransceivers()) {
      if (!['sendrecv', 'recvonly'].includes(transceiver.currentDirection)) continue;
      const track = transceiver.receiver?.track;
      if (track) capture(track).catch(() => { window.__nektoRelay.error = 'Remote audio capture failed.'; });
    }
  };
  let sampling = false;
  const diagnosticsTimer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const current = [...peers];
      window.__nektoRelay.peers = current.length;
      window.__nektoRelay.peerStates = current.map(peer => peer.connectionState);
      window.__nektoRelay.iceStates = current.map(peer => peer.iceConnectionState);
      let packets = 0, bytes = 0;
      for (const peer of current) {
        recoverTracks(peer);
        const stats = await peer.getStats().catch(() => null);
        for (const entry of stats?.values() || []) {
          if (entry.type === 'inbound-rtp' && (entry.kind === 'audio' || entry.mediaType === 'audio')) {
            packets += entry.packetsReceived || 0; bytes += entry.bytesReceived || 0;
          }
        }
      }
      window.__nektoRelay.inboundPackets = packets; window.__nektoRelay.inboundBytes = bytes;
    } catch {} finally { sampling = false; }
  }, 1000);
  window.addEventListener('pagehide', () => clearInterval(diagnosticsTimer), { once: true });
  // Observe peers while preserving the native RTCPeerConnection constructor
  // and microphone APIs. Description hooks capture either caller/callee role.
  const RTC = window.RTCPeerConnection;
  if (RTC && RTC.prototype) {
    const seen = new WeakSet();
    const cleanup = (peer) => {
      recoverTracks(peer);
      if (!['closed', 'failed'].includes(peer.connectionState)) return;
      if (peer.connectionState === 'closed') peers.delete(peer);
      window.__nektoRelay.peers = peers.size;
      for (const receiver of peer.getReceivers()) {
        const captured = tracks.get(receiver.track?.id);
        if (captured) {
          captured.source.disconnect(); captured.playback.pause(); captured.playback.srcObject = null;
          tracks.delete(receiver.track.id);
        }
      }
      window.__nektoRelay.tracks = tracks.size;
    };
    const registerPeer = (peer) => {
      if (!(peer instanceof RTC) || seen.has(peer)) return;
      seen.add(peer);
      peers.add(peer);
      window.__nektoRelay.peers = peers.size;
      peer.addEventListener('track', ({ track }) => {
        if (track.kind === 'audio') window.__nektoRelay.trackEvents++;
        capture(track).catch(() => { window.__nektoRelay.error = 'Remote audio capture failed.'; });
      });
      peer.addEventListener('connectionstatechange', () => cleanup(peer));
    };
    const patch = (name) => {
      const orig = RTC.prototype[name];
      if (typeof orig !== 'function') return;
      RTC.prototype[name] = function(...args) {
        try { registerPeer(this); } catch (_) {}
        return orig.apply(this, args);
      };
    };
    patch('setLocalDescription');
    patch('setRemoteDescription');
    // Native close() does not guarantee a connectionstatechange event.
    const origClose = RTC.prototype.close;
    if (typeof origClose === 'function') {
      RTC.prototype.close = function(...args) {
        const result = origClose.apply(this, args);
        if (seen.has(this)) cleanup(this);
        return result;
      };
    }
    // Register senders without changing their enabled/mute state.
    const origAddTrack = RTC.prototype.addTrack;
    if (typeof origAddTrack === 'function') {
      RTC.prototype.addTrack = function(track, ...streams) {
        try { registerPeer(this); } catch (_) {}
        return origAddTrack.call(this, track, ...streams);
      };
    }
  }
}

// Runs on the loaded origin; return capability/permission checks, no device IDs.
export async function inspectBrowserMicrophone() {
  let permission = 'unavailable', inputs = 0, syntheticInputsOnly = false;
  try { permission = (await navigator.permissions.query({ name: 'microphone' })).state; } catch {}
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
    inputs = devices.length;
    syntheticInputsOnly = inputs > 0 && devices.every(device => /^Fake (?:Default )?Audio Input(?: \d+)?$/.test(device.label));
  } catch {}
  return { permission, inputs, syntheticInputsOnly, modernApi: typeof navigator.mediaDevices?.getUserMedia === 'function',
    legacyApi: typeof navigator.getUserMedia === 'function', webkitApi: typeof navigator.webkitGetUserMedia === 'function' };
}

