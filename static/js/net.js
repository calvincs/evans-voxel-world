// Multiplayer client: a thin WebSocket wrapper that streams our position to
// the world's room and delivers other players' positions and block edits via
// callbacks. Reconnects automatically if the connection drops.

export class Net {
  constructor(worldId, name, handlers) {
    this.handlers = handlers || {};
    this.name = name;
    this.connected = false;
    this.myId = null;
    this.onDown = null;          // called when the socket drops (fast disconnect signal)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.url = `${proto}://${location.host}/api/worlds/${worldId}/ws`;
    this._posT = 0;
    this._retry = null;
    this._open();
  }

  _open() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (_) { this._scheduleRetry(); return; }
    this.ws.onopen = () => {
      this.connected = true;
      this._send({ type: 'hello', name: this.name });
    };
    this.ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      this._dispatch(m);
    };
    this.ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this._scheduleRetry();
      if (was && this.onDown) this.onDown();   // trigger a fast health check
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch (_) {} };
  }

  _scheduleRetry() {
    if (this._retry) return;
    this._retry = setTimeout(() => { this._retry = null; this._open(); }, 2000);
  }

  _send(o) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  _dispatch(m) {
    const h = this.handlers;
    switch (m.type) {
      case 'welcome': this.myId = m.id; h.onWelcome && h.onWelcome(m.id, m.players || []); break;
      case 'join':    h.onJoin && h.onJoin(m); break;
      case 'leave':   h.onLeave && h.onLeave(m.id); break;
      case 'pos':     h.onPos && h.onPos(m); break;
      case 'edit':    h.onEdit && h.onEdit(m); break;
      case 'edits':   h.onEdits && h.onEdits(m.edits || []); break;
      case 'fx':      h.onFx && h.onFx(m); break;
      case 'voice':   h.onVoice && h.onVoice(m); break;
    }
  }

  // Throttled position broadcast (~12/sec is plenty for smooth interpolation).
  sendPos(state, nowMs) {
    if (!this.connected || nowMs - this._posT < 80) return;
    this._posT = nowMs;
    this._send({ type: 'pos', x: state.x, y: state.y, z: state.z,
      yaw: state.yaw, pitch: state.pitch });
  }

  sendEdit(x, y, z, block) { this._send({ type: 'edit', x, y, z, block }); }
  sendEdits(edits) { this._send({ type: 'edits', edits }); }
  // Ephemeral effect (e.g. an explosion) — relayed, never persisted.
  sendFx(kind, x, y, z) { this._send({ type: 'fx', kind, x, y, z }); }

  // --- WebRTC voice signaling (relayed over the same socket) ---------------
  // `to` omitted = broadcast to the room; present = targeted to one peer.
  sendVoiceJoin(to) { this._send({ type: 'voice', sub: 'join', to }); }
  sendVoiceLeave() { this._send({ type: 'voice', sub: 'leave' }); }
  sendVoiceSignal(to, sub, data) { this._send({ type: 'voice', sub, to, ...data }); }
}
