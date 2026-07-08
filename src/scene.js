import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export function createScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070b);
  scene.fog = new THREE.FogExp2(0x05070b, 0.03);

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
  renderer.toneMappingExposure = 1.7;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // ---- 环境反射：让陶瓷装甲与金属关节获得真实的高光与倒影 ----
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  // ---- 后期：Bloom 辉光（发光眼睛 / 状态灯 / 地台光环）----
  const renderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth, window.innerHeight,
    { samples: 4, type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, renderTarget);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.7,    // strength
    0.45,   // radius
    3.2,    // threshold：装甲高光峰值约 2.5-3，只让 >3.2 的自发光泛光
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

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
  const hemi = new THREE.HemisphereLight(0xddeeff, 0x11141a, 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.9);
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

  const rim = new THREE.DirectionalLight(0x60d9ff, 1.4);
  rim.position.set(-4.5, 3.5, -3.5);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffe8d6, 0.55);
  fill.position.set(-3, 2.5, 4);
  scene.add(fill);

  const topLight = new THREE.SpotLight(0xffffff, 7, 12, Math.PI / 5, 0.55, 1.4);
  topLight.position.set(0, 5.5, 1.2);
  topLight.target.position.set(0, 0.7, 0);
  scene.add(topLight, topLight.target);

  // ---- 地面 ----
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0d1117, roughness: 0.62, metalness: 0.35,
    envMapIntensity: 0.7,
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

  const glowRings = [];
  for (const [inner, outer, opacity] of [[0.76, 0.78, 0.8], [0.58, 0.593, 0.34]]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 96),
      new THREE.MeshBasicMaterial({
        // 颜色抬到 HDR 区间，让光环参与 Bloom
        color: new THREE.Color(0x53d8ff).multiplyScalar(3.2),
        transparent: true, opacity,
        side: THREE.DoubleSide, toneMapped: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.004;
    scene.add(ring);
    glowRings.push(ring);
  }

  // 远景全息立柱：几根缓慢明暗呼吸的光柱，强化未来舞台感。
  const pillars = new THREE.Group();
  const pillarGeo = new THREE.CylinderGeometry(0.02, 0.02, 3.2, 8, 1, true);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + 0.35;
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x2f9dc9).multiplyScalar(2.5),
      transparent: true, opacity: 0.16, toneMapped: false,
    });
    const pillar = new THREE.Mesh(pillarGeo, mat);
    pillar.position.set(Math.cos(angle) * 5.4, 1.6, Math.sin(angle) * 5.4);
    pillars.add(pillar);
  }
  scene.add(pillars);

  // 每帧调用：地台光环呼吸 + 光柱闪烁。
  function updateAmbience(t) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.8);
    glowRings[0].material.opacity = 0.55 + pulse * 0.35;
    glowRings[1].material.opacity = 0.22 + (1 - pulse) * 0.2;
    pillars.children.forEach((pillar, index) => {
      pillar.material.opacity = 0.09 + 0.09 * (0.5 + 0.5 * Math.sin(t * 0.7 + index * 1.9));
    });
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, controls, composer, updateAmbience };
}
