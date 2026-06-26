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

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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
    this.onState = null;         // UI callback
    this.onRoster = null;        // (peerId, inVoice) for the who's-online list
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
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this._removePeer(peerId);
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

  // Per-frame: attenuate/pan each peer by how near they are in the world.
  update() {
    if (!this.enabled) return;
    for (const [id, entry] of this.peers) {
      if (!entry.sink) continue;
      const p = this.peerPos(id);
      if (p) audio.setVoiceProximity(entry.sink, p);
      else entry.sink.gain.gain.value = 0;
    }
  }
}
