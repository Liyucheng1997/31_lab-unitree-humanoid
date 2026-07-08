// HUD：绑定动作按钮、滑块、显示/键盘控制
import { ClassicalMusic } from '../audio/ClassicalMusic.js?v=20260708-showtime-v3';

const BEHAVIORS = [
  { id: 'idle', label: '站立' },
  { id: 'walk', label: '走路' },
  { id: 'run', label: '跑步' },
  { id: 'dance', label: '跳舞' },
  { id: 'baduanjin', label: '八段锦' },
  { id: 'kungfu', label: '功夫' },
  { id: 'wave', label: '挥手' },
  { id: 'jump', label: '跳跃' },
  { id: 'backflip', label: '后空翻' },
];

export function initHUD(controller, view, camera, controls) {
  const music = new ClassicalMusic();
  // ---- 动作按钮 ----
  const wrap = document.getElementById('behavior-buttons');
  const buttons = {};
  for (const b of BEHAVIORS) {
    const el = document.createElement('button');
    el.textContent = b.label;
    el.dataset.id = b.id;
    el.addEventListener('click', () => selectBehavior(b.id));
    wrap.appendChild(el);
    buttons[b.id] = el;
  }
  function selectBehavior(id) {
    controller.setBehavior(id);
    if (id === 'baduanjin') music.start().catch((error) => console.warn('背景音乐启动失败：', error));
    else music.stop();
    highlight(id);
  }
  function highlight(name) {
    for (const k of Object.keys(buttons)) buttons[k].classList.toggle('active', k === name);
  }
  selectBehavior('idle');

  // ---- 滑块 ----
  const bind = (id, key, fmt = (v) => v.toFixed(2)) => {
    const slider = document.getElementById(id);
    const out = document.getElementById(id + '-val');
    const apply = () => {
      const v = parseFloat(slider.value);
      controller.params[key] = v;
      out.textContent = fmt(v);
    };
    slider.addEventListener('input', apply);
    apply();
  };
  bind('speed', 'speed');
  bind('stride', 'stride');
  bind('turn', 'turn');

  // ---- 连续镜头距离：补足不同触控板/滚轮设备上缩放过快的问题 ----
  const cameraSlider = document.getElementById('camera-distance');
  const cameraValue = document.getElementById('camera-distance-val');
  const applyCameraDistance = () => {
    const distance = parseFloat(cameraSlider.value);
    const direction = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    view.cameraDistance = distance;
    cameraValue.textContent = `${distance.toFixed(1)}m`;
    controls.update();
  };
  cameraSlider.addEventListener('input', applyCameraDistance);
  controls.addEventListener('change', () => {
    const distance = camera.position.distanceTo(controls.target);
    view.cameraDistance = distance;
    cameraSlider.value = distance.toFixed(1);
    cameraValue.textContent = `${distance.toFixed(1)}m`;
  });
  cameraSlider.value = view.cameraDistance.toFixed(1);
  cameraValue.textContent = `${view.cameraDistance.toFixed(1)}m`;

  // ---- 显示开关 ----
  const skBtn = document.getElementById('toggle-skeleton');
  skBtn.addEventListener('click', () => {
    view.showSkeleton = !view.showSkeleton;
    skBtn.classList.toggle('active', view.showSkeleton);
  });
  const fwBtn = document.getElementById('toggle-follow');
  fwBtn.addEventListener('click', () => {
    view.followCam = !view.followCam;
    fwBtn.classList.toggle('active', view.followCam);
  });
  const musicBtn = document.getElementById('toggle-music');
  musicBtn.addEventListener('click', () => {
    music.setMuted(!music.muted);
    musicBtn.classList.toggle('active', !music.muted);
    musicBtn.textContent = music.muted ? '音乐：关' : '音乐：开';
  });
  musicBtn.classList.add('active');

  // ---- 重力平衡闭环 / 外部扰动测试 ----
  const balanceBtn = document.getElementById('toggle-balance');
  const pushBtn = document.getElementById('push-test');
  balanceBtn.classList.add('active');
  balanceBtn.addEventListener('click', () => {
    controller.balance.enabled = !controller.balance.enabled;
    if (controller.balance.enabled) controller.balance.reset();
    balanceBtn.classList.toggle('active', controller.balance.enabled);
    balanceBtn.textContent = controller.balance.enabled ? '平衡：开' : '平衡：关';
  });
  let pushDirection = 1;
  pushBtn.addEventListener('click', () => {
    // 约 0.25 m/s 的横向速度突变，足以看到闭环恢复但不会刻意推倒机器人。
    controller.applyPush(8.5 * pushDirection, 3.5);
    pushDirection *= -1;
  });

  // ---- 键盘 ----
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === ' ') { e.preventDefault(); selectBehavior('jump'); }
    if (k === 'f') selectBehavior('backflip');
    if (k === 'k') selectBehavior('kungfu');
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  let lastBehavior = controller.behaviorName;

  // 每帧由 main 调用：把键盘转成移动输入，并自动切换行为
  function pollInput() {
    const fwd = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
    const turn = (keys.has('a') ? 1 : 0) - (keys.has('d') ? 1 : 0);
    controller.moveInput.fwd = fwd;
    controller.moveInput.turn = turn;

    const name = controller.behaviorName;
    if (fwd !== 0 && name === 'idle') {
      // W 前进 / S 倒退都自动进入走路；按住 Shift 直接冲刺
      selectBehavior(keys.has('shift') && fwd > 0 ? 'run' : 'walk');
    } else if (keys.has('shift') && fwd > 0 && name === 'walk') {
      selectBehavior('run');
    } else if (!keys.has('shift') && name === 'run' && fwd > 0) {
      selectBehavior('walk');
    }

    // 一次性动作（跳跃/空翻/功夫）结束后自动回 idle，这里同步按钮高亮。
    if (controller.behaviorName !== lastBehavior) {
      lastBehavior = controller.behaviorName;
      highlight(lastBehavior);
    }
  }

  return { pollInput, highlight, music };
}
