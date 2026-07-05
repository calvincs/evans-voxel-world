// Three.js plumbing: renderer, scene, camera, sky + lighting.

import * as THREE from 'three';

const SKY = 0x8ec9ff;

// Is WebGL running in software (SwiftShader/llvmpipe)? Chrome falls back to a
// CPU rasterizer on old or blacklisted GPUs — then every pixel is CPU work, so
// MSAA and extra device pixels directly eat the machine the game logic needs.
// Probed with a throwaway context because antialias must be chosen at creation.
function isSoftwareGL() {
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(
      ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return /swiftshader|llvmpipe|softpipe|software/i.test(name);
  } catch (_) { return false; }
}

export function createRenderer(canvas) {
  // On a software rasterizer, drop MSAA and render at 1:1 pixels: same game,
  // radically less per-pixel CPU on exactly the machines that struggle.
  const software = isSoftwareGL();
  if (software) console.info('EvansGame: software WebGL detected — MSAA off, DPR capped at 1');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !software });
  // Fragment cost scales with pixelRatio^2. Phones/tablets (coarse pointer)
  // often report DPR 2-3 on weaker GPUs, so cap them at 1.5; desktop keeps 2.
  const coarse = matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(software ? 1
    : Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  // Fog tuned to the render distance so far chunks fade in instead of popping.
  // Lighting + fog colour are then driven each frame by the Sky (day/night).
  scene.fog = new THREE.Fog(SKY, 45, 80);

  const camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 0.1, 1000);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Tablets/Chromebooks under memory pressure kill the WebGL context; without
  // this the game silently freezes on a stale frame. Let the browser try to
  // restore it, and reload if it doesn't come back quickly.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    const t = setTimeout(() => location.reload(), 4000);
    canvas.addEventListener('webglcontextrestored', () => clearTimeout(t), { once: true });
  });

  return { renderer, scene, camera };
}
