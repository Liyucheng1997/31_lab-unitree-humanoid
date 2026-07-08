import * as THREE from 'three';
import { createScene } from './scene.js?v=20260708-showtime-v3';
import { buildRobot } from './robot/RobotBuilder.js?v=20260708-showtime-v3';
import { MotionController } from './control/MotionController.js?v=20260708-showtime-v3';
import { initHUD } from './ui/HUD.js?v=20260708-showtime-v3';
import { BADUANJIN_FORMS } from './control/behaviors.js?v=20260708-showtime-v3';

const container = document.getElementById('app');
const { scene, camera, renderer, controls, composer, updateAmbience } = createScene(container);

// ---- 机器人 ----
const rig = buildRobot();
scene.add(rig.root);

const controller = new MotionController(rig);
controller.lookTarget = camera.position; // 待机时头部注视镜头

// ---- 平衡诊断可视化：支撑多边形、COM 投影、ZMP ----
const balanceViz = new THREE.Group();
const supportGeometry = new THREE.BufferGeometry();
supportGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(27), 3));
const supportLine = new THREE.Line(
  supportGeometry,
  new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.85 }),
);
supportLine.frustumCulled = false;
const markerGeometry = new THREE.CircleGeometry(0.022, 24);
const comMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xfbbf24, side: THREE.DoubleSide }));
const zmpMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide }));
comMarker.rotation.x = zmpMarker.rotation.x = -Math.PI / 2;
balanceViz.add(supportLine, comMarker, zmpMarker);
scene.add(balanceViz);

function localGroundPoint(local, y = 0.014) {
  const c = Math.cos(controller.yaw);
  const s = Math.sin(controller.yaw);
  return new THREE.Vector3(
    rig.root.position.x + c * local.x + s * local.z,
    y,
    rig.root.position.z - s * local.x + c * local.z,
  );
}

function updateBalanceViz() {
  const state = controller.balanceState;
  const visible = Boolean(state.support);
  supportLine.visible = visible;
  zmpMarker.visible = visible && Number.isFinite(state.zmp.x);
  comMarker.position.copy(localGroundPoint(state.com));
  comMarker.material.color.setHex(state.status === 'unstable' ? 0xfb7185
    : state.status === 'warning' ? 0xfbbf24 : 0x34d399);
  if (!visible) return;

  const corners = [...state.support.points, state.support.points[0]];
  const attribute = supportGeometry.getAttribute('position');
  supportGeometry.setDrawRange(0, corners.length);
  corners.forEach((corner, index) => {
    const point = localGroundPoint(corner, 0.012);
    attribute.setXYZ(index, point.x, point.y, point.z);
  });
  attribute.needsUpdate = true;
  zmpMarker.position.copy(localGroundPoint(state.zmp, 0.016));
}

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
const view = {
  showSkeleton: false,
  followCam: false,
  cameraDistance: camera.position.distanceTo(controls.target),
};

// ---- HUD ----
const hud = initHUD(controller, view, camera, controls);

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
  updateBalanceViz();
  updateAmbience(clock.elapsedTime);

  // 骨架显隐
  jointDots.visible = view.showSkeleton;
  skeletonHelper.visible = false; // SkeletonHelper 对 Group 骨架支持有限，用关节点代替

  // 跟随相机：让轨道目标跟住机器人，相机随之平移
  const p = rig.root.position;
  if (view.followCam) {
    if (!lastFollow) camOffset.copy(camera.position).sub(controls.target);
    camOffset.setLength(view.cameraDistance);
    const tgt = new THREE.Vector3(p.x, 0.9, p.z);
    controls.target.lerp(tgt, 0.12);
    const desired = new THREE.Vector3().copy(controls.target).add(camOffset);
    camera.position.lerp(desired, 0.12);
  }
  lastFollow = view.followCam;

  controls.update();
  composer.render();

  // 读数
  const form = controller.behaviorName === 'baduanjin'
    ? ` · 第 ${controller.current.formIndex + 1}/8 式 <b>${BADUANJIN_FORMS[controller.current.formIndex]}</b>`
    : '';
  const balance = controller.balanceState;
  const margin = Number.isFinite(balance.margin) ? `${(balance.margin * 100).toFixed(1)}cm` : '腾空';
  // 跑步与跳跃类动作本质是动态步态，捕获点出静稳域是正常现象
  const dynamicGait = ['run', 'jump', 'backflip'].includes(controller.behaviorName);
  const statusLabel = balance.status === 'unstable' && dynamicGait ? '动态'
    : { stable: '稳定', warning: '临界', unstable: '失稳', airborne: '腾空' }[balance.status];
  readout.dataset.stability = balance.status;
  readout.innerHTML =
    `行为 <b>${controller.behaviorName}</b>${form} · ` +
    `平衡 <b class="stability-status">${statusLabel}</b> · 裕度 ${margin} · g ${balance.gravity.toFixed(2)}m/s² · ` +
    `pos (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) · ` +
    `yaw ${(controller.yaw % (Math.PI * 2)).toFixed(2)} · ` +
    `${(1 / Math.max(dt, 1e-3)).toFixed(0)} fps`;
}
animate();

// 暴露到全局便于调试
window.__robot = { rig, controller, scene, camera, view, controls, hud, renderer, composer, updateBalanceViz };
