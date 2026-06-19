import * as THREE from 'three';
import { createScene } from './scene.js?v=20260619-knee-fix';
import { buildRobot } from './robot/RobotBuilder.js?v=20260619-knee-fix';
import { MotionController } from './control/MotionController.js?v=20260619-knee-fix';
import { initHUD } from './ui/HUD.js?v=20260619-knee-fix';
import { BADUANJIN_FORMS } from './control/behaviors.js?v=20260619-knee-fix';

const container = document.getElementById('app');
const { scene, camera, renderer, controls } = createScene(container);

// ---- 机器人 ----
const rig = buildRobot();
scene.add(rig.root);

const controller = new MotionController(rig);

// ---- 骨架可视化（调试用）----
const skeletonHelper = new THREE.SkeletonHelper(rig.root);
skeletonHelper.visible = false;
scene.add(skeletonHelper);
// 关节点可视化
const jointDots = new THREE.Group();
jointDots.visible = false;
const dotGeo = new THREE.SphereGeometry(0.025, 8, 6);
const dotMat = new THREE.MeshBasicMaterial({ color: 0xff3b6b });
for (const name of Object.keys(rig.joints)) {
  const d = new THREE.Mesh(dotGeo, dotMat);
  rig.joints[name].add(d);
  jointDots.add(d);
}
scene.add(jointDots);

// ---- 视图状态 ----
const view = { showSkeleton: false, followCam: false };

// ---- HUD ----
const hud = initHUD(controller, view);

// ---- 状态读数 ----
const readout = document.getElementById('state-readout');

// ---- 跟随相机 ----
const camOffset = new THREE.Vector3();
let lastFollow = false;

// ---- 主循环 ----
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  hud.pollInput();
  controller.update(dt);

  // 骨架显隐
  jointDots.visible = view.showSkeleton;
  skeletonHelper.visible = false; // SkeletonHelper 对 Group 骨架支持有限，用关节点代替

  // 跟随相机：让轨道目标跟住机器人，相机随之平移
  const p = rig.root.position;
  if (view.followCam) {
    if (!lastFollow) camOffset.copy(camera.position).sub(controls.target);
    const tgt = new THREE.Vector3(p.x, 0.9, p.z);
    controls.target.lerp(tgt, 0.12);
    const desired = new THREE.Vector3().copy(controls.target).add(camOffset);
    camera.position.lerp(desired, 0.12);
  }
  lastFollow = view.followCam;

  controls.update();
  renderer.render(scene, camera);

  // 读数
  const form = controller.behaviorName === 'baduanjin'
    ? ` · 第 ${controller.current.formIndex + 1}/8 式 <b>${BADUANJIN_FORMS[controller.current.formIndex]}</b>`
    : '';
  readout.innerHTML =
    `行为 <b>${controller.behaviorName}</b>${form} · ` +
    `pos (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) · ` +
    `yaw ${(controller.yaw % (Math.PI * 2)).toFixed(2)} · ` +
    `${(1 / Math.max(dt, 1e-3)).toFixed(0)} fps`;
}
animate();

// 暴露到全局便于调试
window.__robot = { rig, controller, scene, camera, view, controls, hud };
