// Tracks and renders other players in the world. Positions arrive ~12/sec over
// the network, so we interpolate toward the latest target each frame for smooth
// movement, and drive the walk animation from how fast they're actually moving.

import * as THREE from 'three';
import { Character } from './engine/character.js';
import * as audio from './audio.js';

const COLORS = [0xff6b6b, 0x4db6ff, 0xffd24d, 0xb084ff, 0x55d98a, 0xff9f40, 0xff7ad9];
export const playerColor = (id) => COLORS[id % COLORS.length];
export const SELF_COLOR = 0x3aa657;   // matches your own character's shirt

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map();   // id -> { ch, cur, tgt, yaw, tyaw, pitch }
  }

  _color(id) { return playerColor(id); }

  add(p) {
    if (!p || this.players.has(p.id)) return;
    const x = p.x ?? (p.pos && p.pos.x) ?? 0;
    const y = p.y ?? (p.pos && p.pos.y) ?? 0;
    const z = p.z ?? (p.pos && p.pos.z) ?? 0;
    const yaw = p.yaw ?? (p.pos && p.pos.yaw) ?? 0;
    const ch = new Character(this.scene, this._color(p.id));
    ch.setLabel(p.name || `Player${p.id}`);
    ch.setTransform(x, y, z, yaw);
    this.players.set(p.id, {
      ch,
      cur: new THREE.Vector3(x, y, z),
      tgt: new THREE.Vector3(x, y, z),
      yaw, tyaw: yaw, pitch: p.pitch || 0, stepDist: 0,
    });
  }

  setPos(m) {
    let r = this.players.get(m.id);
    if (!r) { this.add(m); r = this.players.get(m.id); if (!r) return; }
    r.tgt.set(m.x, m.y, m.z);
    r.tyaw = m.yaw;
    r.pitch = m.pitch || 0;
  }

  remove(id) {
    const r = this.players.get(id);
    if (r) { r.ch.dispose(); this.players.delete(id); }
  }

  clear() {
    for (const r of this.players.values()) r.ch.dispose();
    this.players.clear();
  }

  update(dt) {
    const k = Math.min(1, dt * 10);
    for (const r of this.players.values()) {
      const prevX = r.cur.x, prevZ = r.cur.z;
      r.cur.lerp(r.tgt, k);
      let dy = r.tyaw - r.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      r.yaw += dy * k;
      const speed = Math.hypot(r.cur.x - prevX, r.cur.z - prevZ) / Math.max(dt, 1e-3);
      r.ch.setTransform(r.cur.x, r.cur.y, r.cur.z, r.yaw);
      r.ch.animate(dt, speed, r.pitch);

      // Spatial footsteps, paced by distance walked (audio.dest attenuates by
      // range, so far-off players are inaudible).
      if (speed > 0.8) {
        r.stepDist += speed * dt;
        if (r.stepDist > 1.9) {
          audio.playStep({ x: r.cur.x, y: r.cur.y, z: r.cur.z });
          r.stepDist = 0;
        }
      } else {
        r.stepDist = 0;
      }
    }
  }
}
