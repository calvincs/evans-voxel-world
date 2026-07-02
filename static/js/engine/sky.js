// Sky: day/night cycle, drifting clouds, and a starfield that fades in at
// night. Owns the scene lighting and fog colour and animates them over time.

import * as THREE from 'three';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// Sky / fog colour keyframes (r,g,b 0..1).
const DAY   = [0.557, 0.788, 1.0];
const NIGHT = [0.03, 0.04, 0.10];
const DUSK  = [0.95, 0.55, 0.30];   // warm horizon at sunrise/sunset

function mix3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export class Sky {
  // dayLength: real seconds for one full day/night cycle.
  constructor(scene, dayLength = 420) {
    this.scene = scene;
    this.dayLength = dayLength;
    this.time = 0.30;             // 0..1; start mid-morning
    this.daylight = 1;            // 0 night .. 1 full day (read by the glow system)
    this._clockOffset = null;     // server-time anchor; null = free-running
    this._col = new THREE.Color();

    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x40503a, 1.0);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 0.9);
    this.sun.position.set(60, 100, 30);
    scene.add(this.hemi, this.ambient, this.sun);

    this._initClouds();
    this._initStars();
  }

  _initClouds() {
    const tex = makeCloudTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    this.cloudTex = tex;
    const geo = new THREE.PlaneGeometry(3000, 3000);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, opacity: 0.9, fog: false,
      side: THREE.DoubleSide,   // visible from below
    });
    this.clouds = new THREE.Mesh(geo, mat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = 96;
    this.clouds.renderOrder = -1;
    this.scene.add(this.clouds);
  }

  _initStars() {
    const N = 700, pos = new Float32Array(N * 3);
    // Deterministic scatter on a big dome (no Math.random at module load).
    let s = 1234567;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < N; i++) {
      const r = 480, u = rnd(), v = rnd() * 0.5; // upper hemisphere
      const theta = u * Math.PI * 2, phi = Math.acos(1 - v);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) + 40;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.starsMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 2, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(geo, this.starsMat);
    this.scene.add(this.stars);
  }

  // Anchor the day/night phase to a shared wall clock (the server's), so every
  // player in a world sees the same time of day — and the same spiders.
  syncTo(unixSeconds) {
    this._clockOffset = unixSeconds - Date.now() / 1000;
    this.time = this._timeFromClock();
  }

  _timeFromClock() {
    const now = Date.now() / 1000 + this._clockOffset;
    return ((now / this.dayLength) + 0.30) % 1;
  }

  update(dt, playerPos) {
    // Derive time from the anchored clock every frame rather than integrating
    // dt: rAF pauses in background tabs, and an integrated clock came back
    // minutes behind — one kid's wolves hunting while the other's dozed.
    if (this._clockOffset !== null) this.time = this._timeFromClock();
    else this.time = (this.time + dt / this.dayLength) % 1;
    const phase = this.time * Math.PI * 2;
    const sunHeight = -Math.cos(phase);       // -1 midnight .. +1 noon
    const sx = Math.sin(phase);

    // Daylight 0..1 with a little twilight slack.
    const day = clamp01((sunHeight + 0.15) / 0.45);
    this.daylight = day;
    // Warm horizon band when the sun is near the horizon.
    const dusk = clamp01(1 - Math.abs(sunHeight) / 0.18) * clamp01(0.6 + sx);

    let sky = mix3(NIGHT, DAY, day);
    sky = mix3(sky, DUSK, dusk * 0.6);

    this._col.setRGB(sky[0], sky[1], sky[2]);
    this.scene.background.copy(this._col);
    this.scene.fog.color.copy(this._col);

    this.sun.position.set(sx * 120, sunHeight * 120, 40);
    this.sun.intensity = lerp(0.0, 0.95, day);
    this.sun.color.setRGB(1.0, lerp(0.75, 0.96, day), lerp(0.55, 0.88, day));
    this.hemi.intensity = lerp(0.25, 1.0, day);
    this.hemi.color.copy(this._col);
    this.ambient.intensity = lerp(0.10, 0.28, day);

    // Clouds follow the player and drift; fade/darken at night.
    this.clouds.position.x = playerPos.x;
    this.clouds.position.z = playerPos.z;
    this.cloudTex.offset.x += dt * 0.004;
    this.clouds.material.opacity = lerp(0.35, 0.9, day);
    this.clouds.material.color.setRGB(lerp(0.4, 1, day), lerp(0.4, 1, day), lerp(0.5, 1, day));

    // Stars: visible only when it's dark.
    this.stars.position.set(playerPos.x, 0, playerPos.z);
    this.starsMat.opacity = clamp01(1 - day * 1.4);
  }

  // 0..24 clock string for the HUD. time 0 = midnight, 0.25 = dawn,
  // 0.5 = noon, 0.75 = dusk — matching the sun height.
  clock() {
    const h = (this.time * 24) % 24;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
  }
}

// Soft, roughly-tileable cloud texture drawn procedurally.
function makeCloudTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, S, S);

  let s = 987654321;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  const blob = (x, y, r) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  for (let i = 0; i < 26; i++) {
    const x = rnd() * S, y = rnd() * S, r = 16 + rnd() * 34;
    // Draw with wrap-around copies so the texture tiles.
    for (const ox of [-S, 0, S])
      for (const oy of [-S, 0, S])
        blob(x + ox, y + oy, r);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
