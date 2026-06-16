// HUD：绑定动作按钮、滑块、显示/键盘控制
const BEHAVIORS = [
  { id: 'idle', label: '站立' },
  { id: 'walk', label: '走路' },
  { id: 'dance', label: '跳舞' },
  { id: 'wave', label: '挥手' },
  { id: 'jump', label: '跳跃' },
];

export function initHUD(controller, view) {
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

  return { pollInput, highlight };
}
