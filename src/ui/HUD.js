// HUD：绑定动作按钮、滑块、显示/键盘控制
import { ClassicalMusic } from '../audio/ClassicalMusic.js?v=20260619-model-v3';

const BEHAVIORS = [
  { id: 'idle', label: '站立' },
  { id: 'walk', label: '走路' },
  { id: 'dance', label: '跳舞' },
  { id: 'baduanjin', label: '八段锦' },
  { id: 'wave', label: '挥手' },
  { id: 'jump', label: '跳跃' },
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
    for (const k of Object.keys(buttons)) buttons[k].classList.toggle('active', k === id);
    // jump 完成后会自动回 idle，这里短暂高亮
    if (id === 'jump') {
      setTimeout(() => { highlight(controller.behaviorName); }, 1400);
    }
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

  // ---- 键盘 ----
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === ' ') { e.preventDefault(); selectBehavior('jump'); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // 每帧由 main 调用：把键盘转成移动输入，并自动切到 walk
  function pollInput() {
    const fwd = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
    const turn = (keys.has('a') ? 1 : 0) - (keys.has('d') ? 1 : 0);
    controller.moveInput.fwd = fwd;
    controller.moveInput.turn = turn;
    if (fwd > 0 && controller.behaviorName === 'idle') {
      selectBehavior('walk');
    } else if (fwd <= 0 && controller.behaviorName === 'walk' &&
               !keys.has('w')) {
      // 松开 W 时停下（仅当是键盘触发的走路）
    }
  }

  return { pollInput, highlight, music };
}
