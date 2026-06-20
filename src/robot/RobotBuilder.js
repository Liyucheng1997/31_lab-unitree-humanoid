import * as THREE from 'three';
import { DIM, FORWARD_Z } from './skeleton.js?v=20260620-baduanjin-steps-v2';

// 高级材质：陶瓷白装甲 / 阳极黑结构 / 拉丝金属 / 冰蓝状态灯
const MAT = {
  shell: new THREE.MeshPhysicalMaterial({
    color: 0xf3f5f6, roughness: 0.24, metalness: 0.08,
    clearcoat: 0.75, clearcoatRoughness: 0.2,
  }),
  shellShade: new THREE.MeshPhysicalMaterial({
    color: 0xcfd4d7, roughness: 0.3, metalness: 0.12, clearcoat: 0.45,
  }),
  frame: new THREE.MeshStandardMaterial({
    color: 0x111419, roughness: 0.34, metalness: 0.76,
  }),
  rubber: new THREE.MeshStandardMaterial({
    color: 0x080a0d, roughness: 0.74, metalness: 0.05,
  }),
  metal: new THREE.MeshStandardMaterial({
    color: 0x4b525a, roughness: 0.26, metalness: 0.92,
  }),
  visor: new THREE.MeshPhysicalMaterial({
    color: 0x05070a, roughness: 0.08, metalness: 0.42,
    clearcoat: 1, clearcoatRoughness: 0.08,
  }),
  light: new THREE.MeshStandardMaterial({
    color: 0xbff7ff, emissive: 0x35d9ff, emissiveIntensity: 3.2,
    roughness: 0.16, metalness: 0.12,
  }),
};

function finish(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function add(parent, mesh, x = 0, y = 0, z = 0) {
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function box(w, h, d, mat = MAT.shell) {
  return finish(new THREE.Mesh(new THREE.BoxGeometry(w, h, d, 2, 2, 2), mat));
}

function sphere(x, y = x, z = x, mat = MAT.frame, segments = 24) {
  const mesh = finish(new THREE.Mesh(new THREE.SphereGeometry(1, segments, 16), mat));
  mesh.scale.set(x, y, z);
  return mesh;
}

function cylinder(rTop, rBottom, height, mat = MAT.frame, radial = 24) {
  return finish(new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBottom, height, radial, 1, false), mat));
}

function capsule(radius, length, mat = MAT.shell, radial = 16) {
  return finish(new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 8, radial), mat));
}

function ring(major, tube, mat = MAT.metal) {
  const mesh = finish(new THREE.Mesh(new THREE.TorusGeometry(major, tube, 10, 32), mat));
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

// XY 平面的倒角梯形装甲，厚度沿 Z；用于胸甲、髋甲和四肢外壳。
function armorPlate(topW, bottomW, height, depth, mat = MAT.shell, bevel = 0.009) {
  const shape = new THREE.Shape();
  shape.moveTo(-bottomW / 2, -height / 2);
  shape.lineTo(bottomW / 2, -height / 2);
  shape.lineTo(topW / 2, height / 2);
  shape.lineTo(-topW / 2, height / 2);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelSegments: 2,
    bevelSize: bevel, bevelThickness: bevel, curveSegments: 4,
  });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return finish(new THREE.Mesh(geo, mat));
}

function bolt(parent, x, y, z, scale = 1) {
  const b = add(parent, cylinder(0.009 * scale, 0.009 * scale, 0.006, MAT.metal, 12), x, y, z);
  b.rotation.x = Math.PI / 2;
  return b;
}

function buildHead(neck, joints) {
  joints.head = neck;
  add(neck, cylinder(0.041, 0.047, DIM.neckH, MAT.frame), 0, DIM.neckH * 0.15, 0);
  add(neck, ring(0.043, 0.008, MAT.metal), 0, DIM.neckH * 0.22, 0);

  const headY = DIM.neckH * 0.5 + DIM.headH * 0.5;
  add(neck, sphere(0.084, 0.103, 0.078, MAT.frame), 0, headY, -0.006);
  // 白色后脑和顶盖围住独立的黑色面罩。
  add(neck, sphere(0.087, 0.1, 0.057, MAT.shell), 0, headY + 0.006, -0.038);
  const visor = add(neck, sphere(0.069, 0.078, 0.025, MAT.visor), 0, headY - 0.002, 0.071 * FORWARD_Z);
  visor.rotation.x = -0.08;
  add(neck, armorPlate(0.11, 0.14, 0.028, 0.03, MAT.shellShade, 0.004),
    0, headY + 0.082, 0.012);

  // 视觉传感器与下颌灯带。
  for (const x of [-0.045, 0.045]) {
    add(neck, sphere(0.009, 0.009, 0.005, MAT.light, 16), x, headY + 0.004, 0.093 * FORWARD_Z);
    add(neck, ring(0.012, 0.003, MAT.metal), x, headY + 0.004, 0.086 * FORWARD_Z).rotation.x = 0;
  }
  add(neck, box(0.075, 0.008, 0.009, MAT.light), 0, headY - 0.065, 0.084 * FORWARD_Z);
  add(neck, armorPlate(0.09, 0.065, 0.045, 0.04, MAT.frame, 0.004),
    0, headY - 0.087, 0.018);
}

function buildTorso(root, waist, joints) {
  joints.waist = waist;

  // 腰部三层旋转机构。
  add(waist, cylinder(0.075, 0.075, 0.07, MAT.frame), 0, 0.045, 0);
  add(waist, ring(0.07, 0.013, MAT.metal), 0, 0.025, 0);
  add(waist, ring(0.065, 0.009, MAT.rubber), 0, 0.074, 0);
  for (const x of [-0.055, 0.055]) add(waist, cylinder(0.013, 0.013, 0.08, MAT.metal), x, 0.08, 0);

  // 内部脊柱和肋架。
  add(waist, armorPlate(0.18, 0.13, 0.25, 0.125, MAT.frame, 0.012), 0, 0.19, -0.01);
  add(waist, cylinder(0.027, 0.032, 0.25, MAT.metal), 0, 0.19, -0.045);

  // 参考图中的宽肩、收腰白色胸甲，前后壳体分离形成层次。
  const chestFront = add(waist,
    armorPlate(DIM.torsoW * 0.98, DIM.torsoW * 0.72, DIM.torsoH * 0.78, 0.055, MAT.shell, 0.014),
    0, DIM.torsoH * 0.57, 0.083 * FORWARD_Z);
  chestFront.rotation.x = -0.025;
  add(waist,
    armorPlate(DIM.torsoW * 0.92, DIM.torsoW * 0.68, DIM.torsoH * 0.7, 0.05, MAT.shellShade, 0.013),
    0, DIM.torsoH * 0.57, -0.077 * FORWARD_Z);

  // 胸甲中央脊线、品牌徽记和状态灯。
  add(waist, armorPlate(0.026, 0.016, 0.17, 0.013, MAT.shellShade, 0.002),
    0, DIM.torsoH * 0.61, 0.116 * FORWARD_Z);
  add(waist, sphere(0.018, 0.018, 0.007, MAT.frame, 20), 0, DIM.torsoH * 0.69, 0.128 * FORWARD_Z);
  add(waist, sphere(0.008, 0.008, 0.004, MAT.light, 14), 0, DIM.torsoH * 0.69, 0.136 * FORWARD_Z);
  for (const x of [-0.075, 0.075]) {
    add(waist, box(0.009, 0.052, 0.008, MAT.light), x, DIM.torsoH * 0.54, 0.122 * FORWARD_Z);
  }

  // 锁骨与肩胛机械梁。
  add(waist, cylinder(0.032, 0.032, DIM.shoulderWidth * 1.75, MAT.frame), 0, DIM.torsoH * 0.88, 0).rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) {
    add(waist, sphere(0.075, 0.06, 0.066, MAT.frame), s * DIM.shoulderWidth * 0.86, DIM.torsoH * 0.88, 0);
    add(waist, sphere(0.071, 0.052, 0.052, MAT.shell), s * DIM.shoulderWidth * 0.92, DIM.torsoH * 0.9, -0.012);
  }

  // 骨盆核心与左右髋甲。
  add(root, armorPlate(0.23, 0.2, DIM.pelvisH * 0.78, 0.14, MAT.frame, 0.012), 0, 0.005, 0);
  add(root, ring(0.074, 0.012, MAT.metal), 0, DIM.pelvisH * 0.34, 0);
  for (const s of [-1, 1]) {
    const hipArmor = add(root, sphere(0.08, 0.09, 0.068, MAT.shell), s * 0.095, -0.015, 0.006);
    hipArmor.rotation.z = -s * 0.18;
    add(root, armorPlate(0.085, 0.065, 0.115, 0.035, MAT.shellShade, 0.007),
      s * 0.105, -0.018, 0.067 * FORWARD_Z).rotation.z = -s * 0.16;
    bolt(root, s * 0.102, 0.015, 0.092 * FORWARD_Z, 0.8);
  }
}

function buildArm(waist, side, joints) {
  const s = side === 'L' ? 1 : -1;
  const shoulder = new THREE.Group();
  shoulder.name = `shoulder${side}`;
  shoulder.position.set(s * DIM.shoulderWidth, DIM.torsoH * 0.88, 0);
  waist.add(shoulder);
  joints[`shoulder${side}`] = shoulder;

  add(shoulder, sphere(0.061, 0.061, 0.061, MAT.rubber));
  const shoulderCap = add(shoulder, sphere(0.067, 0.052, 0.058, MAT.shell), s * 0.016, 0.008, -0.006);
  shoulderCap.rotation.z = -s * 0.12;
  add(shoulder, ring(0.048, 0.007, MAT.metal), 0, -0.005, 0).rotation.z = Math.PI / 2;

  // 内部上臂骨 + 前后装甲，中间留出黑色关节缝。
  add(shoulder, cylinder(0.033, 0.04, DIM.upperArm * 0.75, MAT.frame), 0, -DIM.upperArm * 0.5, 0);
  const upperArmor = add(shoulder,
    armorPlate(0.078, 0.064, DIM.upperArm * 0.62, 0.075, MAT.shell, 0.008),
    0, -DIM.upperArm * 0.46, 0.012 * FORWARD_Z);
  upperArmor.rotation.z = s * 0.035;
  add(shoulder, armorPlate(0.052, 0.044, DIM.upperArm * 0.38, 0.018, MAT.shellShade, 0.004),
    s * 0.044, -DIM.upperArm * 0.43, -0.006).rotation.y = -s * 0.55;

  const elbow = new THREE.Group();
  elbow.name = `elbow${side}`;
  elbow.position.set(0, -DIM.upperArm, 0);
  shoulder.add(elbow);
  joints[`elbow${side}`] = elbow;
  add(elbow, sphere(0.047, 0.047, 0.047, MAT.rubber));
  add(elbow, cylinder(0.038, 0.038, 0.075, MAT.metal), 0, 0, 0).rotation.z = Math.PI / 2;
  add(elbow, sphere(0.04, 0.04, 0.016, MAT.shell), s * 0.039, 0, 0);
  bolt(elbow, s * 0.052, 0, 0, 0.7).rotation.z = Math.PI / 2;

  add(elbow, cylinder(0.026, 0.035, DIM.foreArm * 0.72, MAT.frame), 0, -DIM.foreArm * 0.5, 0);
  const foreArmor = add(elbow,
    armorPlate(0.066, 0.049, DIM.foreArm * 0.65, 0.068, MAT.shell, 0.007),
    0, -DIM.foreArm * 0.47, 0.014 * FORWARD_Z);
  foreArmor.rotation.z = -s * 0.025;
  add(elbow, armorPlate(0.044, 0.036, DIM.foreArm * 0.42, 0.014, MAT.frame, 0.003),
    -s * 0.037, -DIM.foreArm * 0.48, 0.022 * FORWARD_Z).rotation.y = s * 0.45;

  // 腕部万向环和五指机械手。
  const handY = -DIM.foreArm - 0.018;
  add(elbow, ring(0.028, 0.007, MAT.metal), 0, handY + 0.016, 0);
  add(elbow, sphere(0.036, 0.05, 0.027, MAT.shell), 0, handY - 0.025, 0.004);
  add(elbow, armorPlate(0.046, 0.038, 0.062, 0.022, MAT.frame, 0.004),
    0, handY - 0.025, 0.023 * FORWARD_Z);
  for (let i = 0; i < 5; i++) {
    const fingerX = (i - 2) * 0.011;
    const fingerLen = i === 0 || i === 4 ? 0.041 : 0.052;
    const finger = add(elbow, cylinder(0.0034, 0.0042, fingerLen, MAT.metal, 8),
      fingerX, handY - 0.072 - fingerLen * 0.5, 0.005);
    finger.rotation.z = s * (i - 2) * 0.025;
    add(elbow, sphere(0.005, 0.005, 0.005, MAT.rubber, 10),
      fingerX, handY - 0.071, 0.005);
  }
}

function buildLeg(root, side, joints) {
  const s = side === 'L' ? 1 : -1;
  const hip = new THREE.Group();
  hip.name = `hip${side}`;
  hip.position.set(s * DIM.hipWidth * 0.5, -DIM.pelvisH * 0.4, 0);
  root.add(hip);
  joints[`hip${side}`] = hip;

  add(hip, sphere(0.061, 0.061, 0.061, MAT.rubber));
  add(hip, ring(0.05, 0.009, MAT.metal), 0, 0, 0).rotation.z = Math.PI / 2;
  add(hip, sphere(0.023, 0.023, 0.016, MAT.light), -s * 0.052, 0, 0);

  // 大腿内骨与流线型前/外侧装甲。
  add(hip, cylinder(0.042, 0.05, DIM.thigh * 0.82, MAT.frame), 0, -DIM.thigh * 0.5, 0);
  const thighFront = add(hip,
    armorPlate(0.105, 0.075, DIM.thigh * 0.72, 0.095, MAT.shell, 0.011),
    0, -DIM.thigh * 0.47, 0.018 * FORWARD_Z);
  thighFront.rotation.z = -s * 0.025;
  const thighSide = add(hip,
    armorPlate(0.07, 0.05, DIM.thigh * 0.52, 0.025, MAT.shellShade, 0.006),
    s * 0.055, -DIM.thigh * 0.43, -0.005);
  thighSide.rotation.y = -s * Math.PI / 2;
  add(hip, armorPlate(0.052, 0.042, DIM.thigh * 0.35, 0.014, MAT.frame, 0.003),
    -s * 0.052, -DIM.thigh * 0.58, -0.005).rotation.y = s * Math.PI / 2;

  const knee = new THREE.Group();
  knee.name = `knee${side}`;
  knee.position.set(0, -DIM.thigh, 0);
  hip.add(knee);
  joints[`knee${side}`] = knee;
  add(knee, sphere(0.052, 0.052, 0.052, MAT.rubber));
  add(knee, cylinder(0.041, 0.041, 0.08, MAT.metal), 0, 0, 0).rotation.z = Math.PI / 2;
  add(knee, sphere(0.045, 0.042, 0.025, MAT.shell), 0, 0, 0.042 * FORWARD_Z);
  add(knee, sphere(0.012, 0.012, 0.007, MAT.light), 0, 0, 0.069 * FORWARD_Z);
  add(knee, sphere(0.043, 0.043, 0.016, MAT.shellShade), s * 0.043, 0, 0);
  bolt(knee, s * 0.057, 0, 0, 0.8).rotation.z = Math.PI / 2;

  // 小腿采用后置黑色连杆与前置白色胫骨甲。
  add(knee, cylinder(0.03, 0.039, DIM.shin * 0.84, MAT.frame), 0, -DIM.shin * 0.5, -0.025);
  const shinFront = add(knee,
    armorPlate(0.079, 0.058, DIM.shin * 0.7, 0.075, MAT.shell, 0.009),
    0, -DIM.shin * 0.48, 0.025 * FORWARD_Z);
  shinFront.rotation.z = s * 0.02;
  add(knee, armorPlate(0.028, 0.02, DIM.shin * 0.48, 0.012, MAT.frame, 0.003),
    -s * 0.047, -DIM.shin * 0.5, -0.015).rotation.y = s * 0.7;
  add(knee, box(0.01, DIM.shin * 0.34, 0.007, MAT.light),
    s * 0.035, -DIM.shin * 0.47, 0.068 * FORWARD_Z);

  const ankle = new THREE.Group();
  ankle.name = `ankle${side}`;
  ankle.position.set(0, -DIM.shin, 0);
  knee.add(ankle);
  joints[`ankle${side}`] = ankle;
  add(ankle, sphere(0.04, 0.04, 0.04, MAT.rubber));
  add(ankle, ring(0.033, 0.007, MAT.metal), 0, 0, 0).rotation.z = Math.PI / 2;

  // 两段式脚掌：黑色防滑底 + 白色楔形脚背 + 深色脚尖。
  const footZ = DIM.footLen * 0.16 * FORWARD_Z;
  add(ankle, box(DIM.footWidth, DIM.footH * 0.35, DIM.footLen * 1.08, MAT.rubber),
    0, -DIM.footH * 0.66, footZ);
  const footTop = add(ankle,
    armorPlate(0.087, 0.1, DIM.footLen * 0.7, 0.045, MAT.shell, 0.007),
    0, -DIM.footH * 0.36, footZ + 0.012 * FORWARD_Z);
  footTop.rotation.x = Math.PI / 2;
  add(ankle, box(DIM.footWidth * 0.98, 0.018, 0.045, MAT.frame),
    0, -DIM.footH * 0.52, DIM.footLen * 0.63 * FORWARD_Z);
}

/**
 * 构建高细节人形机器人。运动控制接口保持 { root, joints } 不变。
 * 所有新增装甲均挂在原有枢轴下，因此现有 IK、行为和八段锦可直接驱动。
 */
export function buildRobot() {
  const joints = {};
  const root = new THREE.Group();
  root.name = 'root';

  const waist = new THREE.Group();
  waist.name = 'waist';
  waist.position.set(0, DIM.pelvisH * 0.5, 0);
  root.add(waist);

  buildTorso(root, waist, joints);

  const neck = new THREE.Group();
  neck.name = 'head';
  neck.position.set(0, DIM.torsoH + DIM.neckH * 0.5, 0);
  waist.add(neck);
  buildHead(neck, joints);

  buildArm(waist, 'L', joints);
  buildArm(waist, 'R', joints);
  buildLeg(root, 'L', joints);
  buildLeg(root, 'R', joints);

  root.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return { root, joints };
}
