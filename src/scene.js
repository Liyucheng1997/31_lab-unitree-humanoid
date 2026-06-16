import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e13);
  scene.fog = new THREE.Fog(0x0b0e13, 8, 26);

  // ---- 相机 ----
  const camera = new THREE.PerspectiveCamera(
    45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(2.4, 1.6, 3.2);

  // ---- 渲染器 ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  // ---- 轨道控制 ----
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(0, 0.9, 0);
  controls.minDistance = 1.6;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.49;

  // ---- 灯光 ----
  const hemi = new THREE.HemisphereLight(0x9fc7ff, 0x202028, 0.6);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 25;
  const s = 4;
  key.shadow.camera.left = -s; key.shadow.camera.right = s;
  key.shadow.camera.top = s; key.shadow.camera.bottom = -s;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x38bdf8, 1.1);
  rim.position.set(-5, 3, -4);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-3, 2, 5);
  scene.add(fill);

  // ---- 地面 ----
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x14181f, roughness: 0.9, metalness: 0.1,
  });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 64), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(40, 80, 0x2a3550, 0x1a2030);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  // 中心高亮环
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.6, 1.66, 64),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.001;
  scene.add(ring);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, controls };
}
