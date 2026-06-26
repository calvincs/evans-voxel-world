// Proximity voice chat over WebRTC.
//
// The mic stream flows peer-to-peer (a small full mesh); only signaling
// (offer / answer / ICE) goes through the WebSocket. Each incoming voice
// stream is routed through the spatial audio graph so a speaker gets louder as
// they get closer and fades out with distance.
//
// NOTE: capturing the mic (getUserMedia) requires a secure context — HTTPS, or
// localhost. Over plain http://<lan-ip> the browser blocks it; see README.

import * as audio from './audio.js';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export class Voice {
  // net: the Net instance; myId: () => number; peerPos: (id) => {x,y,z}|null
  constructor(net, myId, peerPos) {
    this.net = net;
    this.myId = myId;
    this.peerPos = peerPos;
    this.peers = new Map();      // peerId -> { pc, sink }
    this.localStream = null;
    this.enabled = false;
    this.muted = false;
    this.pushToTalk = true;      // default: hold a key/button to transmit
    this.transmitting = false;   // PTT key/button currently held
    this.speaking = new Set();   // peer ids whose audio is currently active
    this.selfSpeaking = false;
    this.onState = null;         // UI callback
    this.onRoster = null;        // (peerId, inVoice) for the who's-online list
    this.onPeerState = null;     // (peerId, connectionState) for diagnostics
  }

  // Enable the mic track only when we should actually be sending audio.
  _applyMicState() {
    if (!this.localStream) return;
    const on = this.pushToTalk ? this.transmitting : !this.muted;
    this.localStream.getAudioTracks().forEach((t) => { t.enabled = on; });
  }

  startTalk() {
    if (!this.enabled || this.transmitting) return;
    this.transmitting = true; this._applyMicState();
    if (this.onState) this.onState();
  }

  stopTalk() {
    if (!this.transmitting) return;
    this.transmitting = false; this._applyMicState();
    if (this.onState) this.onState();
  }

  setPushToTalk(on) {
    this.pushToTalk = on; this.transmitting = false; this._applyMicState();
    if (this.onState) this.onState();
  }

  available() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  async enable() {
    if (this.enabled) return true;
    if (!this.available()) return false;     // insecure context — caller explains
    audio.ensureAudio();
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (_) {
      return false;                          // permission denied / no mic
    }
    this.enabled = true;
    this._applyMicState();                   // start silent in push-to-talk mode
    this.net.sendVoiceJoin();                // announce to the room
    if (this.onState) this.onState();
    return true;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.localStream) this.localStream.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    if (this.onState) this.onState();
    return this.muted;
  }

  leave() {
    this.net.sendVoiceLeave();
    for (const id of [...this.peers.keys()]) this._removePeer(id);
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.enabled = false;
    this.muted = false;
    if (this.onState) this.onState();
  }

  // --- Signaling (dispatched from main on net.onVoice) ----------------------
  handle(m) {
    switch (m.sub) {
      case 'join':   this._onJoin(m.from); break;
      case 'leave':  this._onLeave(m.from); break;
      case 'offer':  this._onOffer(m.from, m.sdp); break;
      case 'answer': this._onAnswer(m.from, m.sdp); break;
      case 'ice':    this._onIce(m.from, m.candidate); break;
    }
  }

  _onJoin(peerId) {
    if (!this.enabled || peerId === this.myId()) return;
    const isNew = !this.peers.has(peerId);
    this._ensurePeer(peerId, this.myId() < peerId);   // lower id initiates the offer
    if (isNew) this.net.sendVoiceJoin(peerId);        // reciprocate once so they know us
    if (this.onRoster) this.onRoster(peerId, true);
  }

  _onLeave(peerId) {
    this._removePeer(peerId);
    if (this.onRoster) this.onRoster(peerId, false);
  }

  _ensurePeer(peerId, initiator) {
    let entry = this.peers.get(peerId);
    if (entry) return entry;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    entry = { pc, sink: null };
    this.peers.set(peerId, entry);
    if (this.localStream) this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
    pc.onicecandidate = (e) => {
      if (e.candidate) this.net.sendVoiceSignal(peerId, 'ice', { candidate: e.candidate });
    };
    pc.ontrack = (e) => { if (!entry.sink) entry.sink = audio.voiceSink(e.streams[0]); };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (this.onPeerState) this.onPeerState(peerId, st);
      // 'disconnected' can recover, so only tear down on a hard failure.
      if (st === 'failed' || st === 'closed') this._removePeer(peerId);
    };
    if (initiator) {
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.net.sendVoiceSignal(peerId, 'offer', { sdp: pc.localDescription }))
        .catch(() => {});
    }
    return entry;
  }

  async _onOffer(peerId, sdp) {
    if (!this.enabled) return;
    const entry = this._ensurePeer(peerId, false);
    try {
      await entry.pc.setRemoteDescription(sdp);
      const ans = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(ans);
      this.net.sendVoiceSignal(peerId, 'answer', { sdp: entry.pc.localDescription });
      if (this.onRoster) this.onRoster(peerId, true);
    } catch (_) {}
  }

  async _onAnswer(peerId, sdp) {
    const entry = this.peers.get(peerId);
    if (entry) { try { await entry.pc.setRemoteDescription(sdp); } catch (_) {} }
  }

  async _onIce(peerId, candidate) {
    const entry = this.peers.get(peerId);
    if (entry && candidate) { try { await entry.pc.addIceCandidate(candidate); } catch (_) {} }
  }

  _removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    audio.disposeVoiceSink(entry.sink);
    try { entry.pc.close(); } catch (_) {}
    this.peers.delete(peerId);
  }

  isSpeaking(id) { return this.speaking.has(id); }

  // Debug: raw audio level for a peer (-1 if no sink yet).
  peerLevel(id) {
    const e = this.peers.get(id);
    return e && e.sink ? audio.voiceLevel(e.sink) : -1;
  }
  ctxState() { return audio.audioCtxState(); }

  // Per-frame: attenuate/pan each peer by how near they are, and detect who's
  // currently talking (from the raw incoming audio level).
  update() {
    if (!this.enabled) return;
    for (const [id, entry] of this.peers) {
      if (!entry.sink) { this.speaking.delete(id); continue; }
      audio.setVoiceProximity(entry.sink, this.peerPos(id));   // audible even if pos unknown
      // Noise gate: real speech is ~0.05–0.3 RMS, idle/quiet sits near 0.
      if (audio.voiceLevel(entry.sink) > 0.02) this.speaking.add(id);
      else this.speaking.delete(id);
    }
    this.selfSpeaking = this.pushToTalk ? this.transmitting : !this.muted;
  }
}
