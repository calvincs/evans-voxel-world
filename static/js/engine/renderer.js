// Three.js plumbing: renderer, scene, camera, sky + lighting.

import * as THREE from 'three';

const SKY = 0x8ec9ff;

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Fragment cost scales with pixelRatio^2. Phones/tablets (coarse pointer)
  // often report DPR 2-3 on weaker GPUs, so cap them at 1.5; desktop keeps 2.
  const coarse = matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
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

  return { renderer, scene, camera };
}
