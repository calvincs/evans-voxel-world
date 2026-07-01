// A simple blocky voxel character: head, torso, two arms, two legs,
// each limb pivoted so it can swing for a walk animation. Used both for the
// third-person view of yourself and for other players in multiplayer.

import * as THREE from 'three';

const SKIN = 0xe6b27a;
const PANTS = 0x33415e;

// dimensions (blocks)
const LEG_H = 0.72, TORSO_H = 0.70, HEAD = 0.46;
const TORSO_W = 0.5, TORSO_D = 0.26, ARM_W = 0.22, ARM_H = 0.70, LEG_W = 0.24;

function limb(w, h, d, color, pivotTopY, x) {
  // A box whose TOP is at the group's origin, so the group can be placed at the
  // joint and rotated to swing the limb.
  const g = new THREE.Group();
  g.position.set(x, pivotTopY, 0);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color }));
  mesh.position.y = -h / 2;
  g.add(mesh);
  return g;
}

export class Character {
  constructor(scene, shirtColor = 0x3aa657) {
    this.scene = scene;
    this.phase = 0;
    this.walk = 0;
    this.group = new THREE.Group();

    // Torso.
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(TORSO_W, TORSO_H, TORSO_D),
      new THREE.MeshLambertMaterial({ color: shirtColor }));
    torso.position.y = LEG_H + TORSO_H / 2;
    this.group.add(torso);

    // Head with a simple face.
    this.head = new THREE.Group();
    this.head.position.y = LEG_H + TORSO_H;          // pivot at neck
    const headMesh = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD, HEAD, HEAD),
      new THREE.MeshLambertMaterial({ color: SKIN }));
    headMesh.position.y = HEAD / 2;
    this.head.add(headMesh);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    for (const sx of [-0.1, 0.1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.02), eyeMat);
      eye.position.set(sx, HEAD / 2 + 0.02, -HEAD / 2 - 0.005);   // front (−Z)
      this.head.add(eye);
    }
    this.group.add(this.head);

    // Arms + legs (pivoted at shoulder / hip).
    const shoulderY = LEG_H + TORSO_H;
    this.armL = limb(ARM_W, ARM_H, ARM_W, shirtColor, shoulderY, -(TORSO_W / 2 + ARM_W / 2));
    this.armR = limb(ARM_W, ARM_H, ARM_W, shirtColor, shoulderY, (TORSO_W / 2 + ARM_W / 2));
    this.legL = limb(LEG_W, LEG_H, LEG_W, PANTS, LEG_H, -LEG_W / 2);
    this.legR = limb(LEG_W, LEG_H, LEG_W, PANTS, LEG_H, LEG_W / 2);
    this.group.add(this.armL, this.armR, this.legL, this.legR);

    scene.add(this.group);
  }

  setLabel(text) {
    if (this.label) { this.group.remove(this.label); this.label.material.map.dispose(); }
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.font = 'bold 34px Trebuchet MS, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const w = ctx.measureText(text).width + 28;
    ctx.fillRect((256 - w) / 2, 8, w, 48);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    spr.scale.set(1.6, 0.4, 1);
    spr.position.y = LEG_H + TORSO_H + HEAD + 0.35;
    this.label = spr;
    this.group.add(spr);
  }

  // Show a little speech bubble above the head while this player is talking.
  setSpeaking(on) {
    if (on === this._speaking) return;
    this._speaking = on;
    if (on && !this._speakSprite) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const c = cv.getContext('2d');
      c.fillStyle = '#2f9f3c';
      c.beginPath(); c.arc(32, 28, 22, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.moveTo(22, 44); c.lineTo(40, 44); c.lineTo(28, 60); c.closePath(); c.fill();
      c.fillStyle = '#fff';                    // three dots
      for (const dx of [-10, 0, 10]) { c.beginPath(); c.arc(32 + dx, 28, 4, 0, Math.PI * 2); c.fill(); }
      const tex = new THREE.CanvasTexture(cv);
      this._speakSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      this._speakSprite.scale.set(0.45, 0.45, 1);
      this._speakSprite.position.y = LEG_H + TORSO_H + HEAD + 0.75;
      this.group.add(this._speakSprite);
    }
    if (this._speakSprite) this._speakSprite.visible = on;
  }

  setTransform(x, y, z, yaw) {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;     // model faces −Z at yaw 0, matching look dir
  }

  // speed: horizontal m/s; pitch: head tilt.
  animate(dt, speed, pitch) {
    const target = Math.min(1, speed / 5);
    this.walk += (target - this.walk) * Math.min(1, dt * 10);
    this.phase += dt * (2.2 + speed * 1.4);
    const s = Math.sin(this.phase) * this.walk;
    this.legL.rotation.x = s * 0.7;
    this.legR.rotation.x = -s * 0.7;
    this.armL.rotation.x = -s * 0.55;
    this.armR.rotation.x = s * 0.55;
    this.head.rotation.x = Math.max(-0.5, Math.min(0.5, -pitch * 0.6));
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  }
}
