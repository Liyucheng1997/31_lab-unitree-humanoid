// 工程视图面板：X 光透视、爆炸视图、整机建模统计、执行器悬停检视。
import * as THREE from 'three';
import { MOTORS } from '../robot/description.js?v=20261002-eng-v1';

const MOTOR_INFO = {
  J120: '高扭矩关节模组',
  J27: '中扭矩关节模组',
  J9: '末端小模组',
};

export function initInspector({ rig, controller, camera, canvas }) {
  // ---- X 光 ----
  const xrayBtn = document.getElementById('toggle-xray');
  let xray = false;
  xrayBtn.addEventListener('click', () => {
    xray = !xray;
    rig.setXRay(xray);
    xrayBtn.classList.toggle('active', xray);
  });

  // ---- 爆炸视图：滑块直接控制，按钮做 0↔1 的缓动动画 ----
  const slider = document.getElementById('explode');
  const out = document.getElementById('explode-val');
  const explodeBtn = document.getElementById('toggle-explode');
  let explode = 0;
  let explodeTarget = 0;
  const applyExplode = (t) => {
    explode = t;
    rig.setExplode(t);
    slider.value = t.toFixed(2);
    out.textContent = `${Math.round(t * 100)}%`;
    explodeBtn.classList.toggle('active', t > 0.01);
  };
  slider.addEventListener('input', () => {
    explodeTarget = parseFloat(slider.value);
    applyExplode(explodeTarget);
  });
  explodeBtn.addEventListener('click', () => {
    explodeTarget = explode > 0.5 ? 0 : 1;
  });

  // ---- 建模统计 ----
  const st = rig.stats;
  document.getElementById('model-stats').innerHTML =
    `零件 <b>${st.parts}</b> · 执行器 <b>${st.actuators}</b> · 外壳 <b>${rig.shells.length}</b><br>` +
    `网格 <b>${st.meshes}</b> · 三角面 <b>${(st.triangles / 1000).toFixed(0)}k</b>`;

  // ---- 悬停检视 ----
  const tip = document.getElementById('inspect-tip');
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = null;
  let pointerDirty = false;
  let pointerX = 0;
  let pointerY = 0;
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerDirty = true;
  });
  canvas.addEventListener('pointerleave', () => { hovered = null; tip.hidden = true; });

  const pick = () => {
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(rig.inspectables, false)[0];
    return hit ? hit.object.userData.inspect : null;
  };

  function renderTip() {
    if (!hovered) { tip.hidden = true; return; }
    const act = controller.actuators.byName.get(hovered.joint);
    const motor = MOTORS[hovered.motor];
    const name = hovered.joint.replace('_joint', '');
    let body = `<div class="it-title">${name}</div>` +
      `<div class="it-sub">${hovered.motor} · ${MOTOR_INFO[hovered.motor]} · ${motor.effort}N·m / ${motor.velocity}rad/s</div>`;
    if (act) {
      const load = Math.min(1, Math.abs(act.torque) / act.spec.effort);
      const deg = (v) => (v * 180 / Math.PI).toFixed(1);
      body += `<div class="it-grid">` +
        `<span>角度</span><b>${deg(act.q)}°</b>` +
        `<span>目标</span><b>${deg(act.target)}°</b>` +
        `<span>角速度</span><b>${act.dq.toFixed(2)} rad/s</b>` +
        `<span>力矩</span><b>${act.torque.toFixed(1)} N·m</b>` +
        `<span>限位</span><b>${deg(act.spec.lower)}° ~ ${deg(act.spec.upper)}°</b>` +
        `<span>kp / kd</span><b>${act.spec.kp.toFixed(1)} / ${act.spec.kd.toFixed(2)}</b>` +
        `</div><div class="it-bar"><i style="width:${(load * 100).toFixed(0)}%"></i></div>`;
    }
    tip.innerHTML = body;
    tip.hidden = false;
    const pad = 16;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.min(pointerX + pad, window.innerWidth - w - 8)}px`;
    tip.style.top = `${Math.min(pointerY + pad, window.innerHeight - h - 8)}px`;
  }

  let lastTip = 0;
  /** 每帧调用：爆炸缓动 + 悬停拾取（限频）+ 提示刷新。 */
  function update(dt) {
    if (Math.abs(explodeTarget - explode) > 1e-3) {
      applyExplode(explode + (explodeTarget - explode) * (1 - Math.exp(-dt / 0.18)));
    }
    const now = performance.now();
    if (pointerDirty && now - lastTip > 50) {
      pointerDirty = false;
      hovered = pick();
    }
    if (now - lastTip > 100) {
      lastTip = now;
      renderTip();
    }
  }

  return { update };
}
