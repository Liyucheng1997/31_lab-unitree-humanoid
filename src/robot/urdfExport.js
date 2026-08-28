// URDF 导出（对齐 roboto_origin 的 rpo_description/urdf）。
// 把 description.js 的关节表 + skeleton.js 的几何生成标准 URDF，
// 可直接被 MuJoCo (mjcf 转换)、Isaac Lab、Pybullet、RViz 加载——
// 这是"玩具渲染"通往真实机器人工具链的桥。
//
// 轴系换算：Three.js 场景 Y 向上 / +Z 正面；URDF 惯例 Z 向上 / +X 正面。
// 映射 (x,y,z)_three -> (z_three, x_three, y_three)_urdf，
// 即 three 的 X(左) -> urdf Y，three 的 Y(上) -> urdf Z，three 的 Z(前) -> urdf X。
// 关节旋转轴同样换算：绕 three-X -> urdf (0,1,0)，绕 three-Y -> urdf (0,0,1)，
// 绕 three-Z -> urdf (1,0,0)。

import { jointSpecs, LINK_MASS, URDF_GEOM } from './description.js?v=20260828-rpo-v1';

const AXIS_URDF = { x: '0 1 0', y: '0 0 1', z: '1 0 0' };
const f = (n) => Number(n.toFixed(5));
const vec = (t) => `${f(t.z)} ${f(t.x)} ${f(t.y)}`;   // three -> urdf

// 简化惯量：按均匀盒/圆柱粗算，量级正确即可（精调交给 CAD）。
function inertiaBox(m, x, y, z) {
  const ixx = (m / 12) * (y * y + z * z);
  const iyy = (m / 12) * (x * x + z * z);
  const izz = (m / 12) * (x * x + y * y);
  return { ixx, iyy, izz };
}

function linkXml(name, mass, box, originThree = { x: 0, y: 0, z: 0 }) {
  // box 的 {w,h,d} 是 three 轴系 (X宽, Y高, Z深)，转 urdf 为 (d, w, h)。
  const size = `${f(box.d)} ${f(box.w)} ${f(box.h)}`;
  const inertia = inertiaBox(mass, box.d, box.w, box.h);
  const origin = vec(originThree);
  return `  <link name="${name}">
    <inertial>
      <origin xyz="${origin}" rpy="0 0 0"/>
      <mass value="${f(mass)}"/>
      <inertia ixx="${f(inertia.ixx)}" ixy="0" ixz="0" iyy="${f(inertia.iyy)}" iyz="0" izz="${f(inertia.izz)}"/>
    </inertial>
    <visual>
      <origin xyz="${origin}" rpy="0 0 0"/>
      <geometry><box size="${size}"/></geometry>
    </visual>
    <collision>
      <origin xyz="${origin}" rpy="0 0 0"/>
      <geometry><box size="${size}"/></geometry>
    </collision>
  </link>`;
}

function jointXml(spec, parent, child, originThree) {
  return `  <joint name="${spec.name}" type="revolute">
    <parent link="${parent}"/>
    <child link="${child}"/>
    <origin xyz="${vec(originThree)}" rpy="0 0 0"/>
    <axis xyz="${AXIS_URDF[spec.axis]}"/>
    <limit lower="${f(spec.lower)}" upper="${f(spec.upper)}" effort="${f(spec.effort)}" velocity="${f(spec.velocity)}"/>
    <dynamics damping="0.05" friction="0.02"/>
  </joint>`;
}

/**
 * 生成完整 URDF 文本。
 * 结构与 rpo.urdf 同构：base_link 为骨盆浮动基座，腿臂为单轴关节链。
 * 同一 Group 的多个旋转分量展开成串联的单轴关节（中间用零质量虚拟 link）。
 */
export function generateURDF(robotName = 'rpo_web_humanoid') {
  const G = URDF_GEOM;
  const specs = jointSpecs();
  const byGroup = new Map();
  for (const s of specs) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
  }

  const links = [];
  const joints = [];

  // 每个 Group 的：父 link 名、关节原点（three 轴系、相对父关节系）、末端 link 几何。
  const zero = { x: 0, y: 0, z: 0 };
  const chains = [];
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const p = side === 'L' ? 'left' : 'right';
    chains.push(
      { group: `hip${side}`, parent: 'base_link',
        origin: { x: s * G.hipOffset.x, y: G.hipOffset.y, z: 0 },
        link: { name: `${p}_thigh_link`, mass: LINK_MASS.thigh,
          box: { w: 0.11, h: G.thighLen, d: 0.11 },
          center: { x: 0, y: -G.thighLen / 2, z: 0 } } },
      { group: `knee${side}`, parent: `${p}_thigh_link`,
        origin: { x: 0, y: -G.thighLen, z: 0 },
        link: { name: `${p}_shin_link`, mass: LINK_MASS.shin,
          box: { w: 0.09, h: G.shinLen, d: 0.09 },
          center: { x: 0, y: -G.shinLen / 2, z: 0 } } },
      { group: `ankle${side}`, parent: `${p}_shin_link`,
        origin: { x: 0, y: -G.shinLen, z: 0 },
        link: { name: `${p}_foot_link`, mass: LINK_MASS.foot,
          box: { w: G.foot.width, h: G.foot.height, d: G.foot.len },
          center: { x: 0, y: -G.foot.height * 0.66, z: G.foot.len * 0.16 } } },
      { group: `shoulder${side}`, parent: 'torso_link',
        origin: { x: s * G.shoulderOffset.x, y: G.shoulderOffset.y - G.waistY, z: 0 },
        link: { name: `${p}_upper_arm_link`, mass: LINK_MASS.upperArm,
          box: { w: 0.08, h: G.upperArmLen, d: 0.08 },
          center: { x: 0, y: -G.upperArmLen / 2, z: 0 } } },
      { group: `elbow${side}`, parent: `${p}_upper_arm_link`,
        origin: { x: 0, y: -G.upperArmLen, z: 0 },
        link: { name: `${p}_forearm_link`, mass: LINK_MASS.foreArm,
          box: { w: 0.07, h: G.foreArmLen, d: 0.07 },
          center: { x: 0, y: -G.foreArmLen / 2, z: 0 } } },
      { group: `wrist${side}`, parent: `${p}_forearm_link`,
        origin: { x: 0, y: -G.foreArmLen - 0.018, z: 0 },
        link: { name: `${p}_hand_link`, mass: LINK_MASS.hand,
          box: { w: 0.05, h: 0.11, d: 0.03 },
          center: { x: 0, y: -0.05, z: 0 } } },
    );
  }
  chains.push(
    { group: 'waist', parent: 'base_link',
      origin: { x: 0, y: G.waistY, z: 0 },
      link: { name: 'torso_link', mass: LINK_MASS.torso,
        box: { w: G.torso.w, h: G.torso.h, d: G.torso.d },
        center: { x: 0, y: G.torso.h * 0.55, z: 0 } } },
    { group: 'head', parent: 'torso_link',
      origin: { x: 0, y: G.neckY - G.waistY, z: 0 },
      link: { name: 'head_link', mass: LINK_MASS.head,
        box: { w: G.head.w, h: G.head.h, d: G.head.w },
        center: { x: 0, y: 0.14, z: 0 } } },
  );

  // base_link（骨盆）
  links.push(linkXml('base_link', LINK_MASS.pelvis,
    { w: G.pelvis.w, h: G.pelvis.h, d: G.pelvis.d }, zero));

  for (const chain of chains) {
    const groupSpecs = byGroup.get(chain.group) || [];
    if (groupSpecs.length === 0) continue;
    let parent = chain.parent;
    let origin = chain.origin;
    groupSpecs.forEach((spec, i) => {
      const isLast = i === groupSpecs.length - 1;
      const childName = isLast
        ? chain.link.name
        : `${chain.link.name}_${spec.axis}_dummy`;
      if (isLast) {
        links.push(linkXml(childName, chain.link.mass, chain.link.box, chain.link.center));
      } else {
        // 串联虚拟 link：零尺寸、极小质量，URDF 解析器都能接受。
        links.push(linkXml(childName, 0.001, { w: 0.01, h: 0.01, d: 0.01 }, zero));
      }
      joints.push(jointXml(spec, parent, childName, origin));
      parent = childName;
      origin = zero;
    });
  }

  return `<?xml version="1.0"?>
<!-- 由 web 人形机器人项目自动生成，结构对齐 Roboparty roboto_origin 的 rpo.urdf -->
<robot name="${robotName}">
${links.join('\n')}
${joints.join('\n')}
</robot>
`;
}

/** 浏览器端下载 URDF 文件。 */
export function downloadURDF() {
  const blob = new Blob([generateURDF()], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rpo_web_humanoid.urdf';
  a.click();
  URL.revokeObjectURL(url);
}
