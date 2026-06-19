import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07090d);
  scene.fog = new THREE.FogExp2(0x07090d, 0.032);

  // ---- 相机 ----
  const camera = new THREE.PerspectiveCamera(
    45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(1.65, 1.28, 2.3);

  // ---- 渲染器 ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // ---- 轨道控制 ----
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enableZoom = true;
  controls.zoomSpeed = 0.38;
  controls.zoomToCursor = true;
  controls.target.set(0, 0.82, 0);
  controls.minDistance = 1.5;
  controls.maxDistance = 7;
  controls.maxPolarAngle = Math.PI * 0.49;

  // ---- 灯光 ----
  const hemi = new THREE.HemisphereLight(0xddeeff, 0x11141a, 1.15);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(3.5, 6, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 25;
  const s = 4;
  key.shadow.camera.left = -s; key.shadow.camera.right = s;
  key.shadow.camera.top = s; key.shadow.camera.bottom = -s;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x60d9ff, 2.2);
  rim.position.set(-4.5, 3.5, -3.5);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffe8d6, 1.0);
  fill.position.set(-3, 2.5, 4);
  scene.add(fill);

  const topLight = new THREE.SpotLight(0xffffff, 28, 12, Math.PI / 5, 0.55, 1.4);
  topLight.position.set(0, 5.5, 1.2);
  topLight.target.position.set(0, 0.7, 0);
  scene.add(topLight, topLight.target);

  // ---- 地面 ----
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0d1117, roughness: 0.76, metalness: 0.28,
  });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 64), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(40, 80, 0x263344, 0x151b24);
  grid.material.transparent = true;
  grid.material.opacity = 0.28;
  scene.add(grid);

  // 展示台：黑色金属底座、发光环和内圈细节。
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.86, 0.9, 0.08, 96),
    new THREE.MeshStandardMaterial({ color: 0x141a22, roughness: 0.32, metalness: 0.78 })
  );
  pedestal.position.y = -0.045;
  pedestal.receiveShadow = true;
  scene.add(pedestal);

  for (const [inner, outer, opacity] of [[0.76, 0.78, 0.8], [0.58, 0.593, 0.34]]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 96),
      new THREE.MeshBasicMaterial({
        color: 0x53d8ff, transparent: true, opacity,
        side: THREE.DoubleSide, toneMapped: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.004;
    scene.add(ring);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, controls };
}
