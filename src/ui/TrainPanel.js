// 强化学习训练面板：后台 Worker 训练 + 奖励曲线 + 一键部署（PD ↔ RL）。
// Worker 不可用（如 file:// 打开）时降级为主线程逐迭代训练。

import { PolicyBalancer } from '../rl/PolicyBalancer.js?v=20260828-rpo-v1';

export function initTrainPanel(controller) {
  const balancer = new PolicyBalancer();
  const state = {
    training: false,
    deployed: false,
    latestWeights: null,
    history: [],          // meanEpReturn 曲线
    fallbackTrainer: null,
  };

  const startBtn = document.getElementById('rl-train');
  const resetBtn = document.getElementById('rl-reset');
  const deployBtn = document.getElementById('rl-deploy');
  const exportBtn = document.getElementById('rl-export');
  const importInput = document.getElementById('rl-import');
  const importBtn = document.getElementById('rl-import-btn');
  const readout = document.getElementById('rl-readout');
  const canvas = document.getElementById('rl-curve');
  const ctx = canvas.getContext('2d');

  // ---- Worker（含主线程降级）----
  let worker = null;
  try {
    worker = new Worker(
      new URL('../rl/trainWorker.js?v=20260828-rpo-v1', import.meta.url),
      { type: 'module' });
    worker.onmessage = (event) => handleMessage(event.data);
    worker.onerror = (error) => {
      console.warn('训练 Worker 异常，降级到主线程训练：', error.message);
      worker = null;
    };
  } catch (error) {
    console.warn('无法创建训练 Worker，降级到主线程训练：', error);
    worker = null;
  }

  function handleMessage(msg) {
    if (msg.type === 'stats') {
      if (msg.iter === 0) state.history = [];
      else state.history.push(msg.meanEpReturn);
      if (state.history.length > 400) state.history.shift();
      updateReadout(msg);
      drawCurve();
    } else if (msg.type === 'policy' || msg.type === 'weights') {
      state.latestWeights = msg.data;
      balancer.loadWeights(msg.data);
      // 已部署时热更新：训练中的策略实时反映到机器人上
      if (state.deployed) balancer.attach(controller.balance, true);
      if (msg.type === 'weights') downloadWeights(msg.data);
      deployBtn.disabled = false;
      exportBtn.disabled = false;
    }
  }

  function updateReadout(stats) {
    const best = Number.isFinite(stats.bestReturn)
      ? ` · 最优 <em>${stats.bestReturn.toFixed(1)}</em>@${stats.bestIter}` : '';
    readout.innerHTML =
      `迭代 <b>${stats.iter}</b> · 样本 ${(stats.totalSteps / 1000).toFixed(0)}k · ` +
      `回合回报 <b>${stats.meanEpReturn.toFixed(1)}</b>${best} · ` +
      `存活 ${stats.meanEpLen ? stats.meanEpLen.toFixed(0) : 0} 步` +
      (worker ? '' : ' · <em>主线程模式</em>');
  }

  function drawCurve() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const data = state.history;
    if (data.length < 2) return;
    let lo = Math.min(...data);
    let hi = Math.max(...data);
    if (hi - lo < 1e-6) hi = lo + 1;
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * (w - 4) + 2;
      const y = h - 3 - ((v - lo) / (hi - lo)) * (h - 8);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
    ctx.font = '9px monospace';
    ctx.fillText(hi.toFixed(0), 3, 9);
    ctx.fillText(lo.toFixed(0), 3, h - 3);
  }

  function downloadWeights(data) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rpo_balance_policy_iter${data.updates || 0}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- 主线程降级训练：每帧最多一迭代，尽量少卡 ----
  async function fallbackLoop() {
    if (!state.fallbackTrainer) {
      const { TrainerCore } = await import('../rl/Trainer.js?v=20260828-rpo-v1');
      state.fallbackTrainer = new TrainerCore();
    }
    const step = () => {
      if (!state.training) return;
      const stats = state.fallbackTrainer.iterate();
      handleMessage({ type: 'stats', ...stats });
      handleMessage({ type: 'policy', data: state.fallbackTrainer.deployWeights() });
      setTimeout(step, 60);   // 给渲染留喘息
    };
    step();
  }

  // ---- 控件 ----
  startBtn.addEventListener('click', () => {
    state.training = !state.training;
    startBtn.textContent = state.training ? '训练：停' : '训练：开';
    startBtn.classList.toggle('active', state.training);
    if (worker) worker.postMessage({ type: state.training ? 'start' : 'pause' });
    else if (state.training) fallbackLoop();
  });

  resetBtn.addEventListener('click', () => {
    state.training = false;
    startBtn.textContent = '训练：开';
    startBtn.classList.remove('active');
    state.history = [];
    if (worker) worker.postMessage({ type: 'reset' });
    else state.fallbackTrainer = null;
    drawCurve();
    readout.textContent = '已重置';
  });

  deployBtn.addEventListener('click', () => {
    if (!balancer.ready) return;
    state.deployed = !state.deployed;
    balancer.attach(controller.balance, state.deployed);
    deployBtn.textContent = state.deployed ? '控制器：RL' : '控制器：PD';
    deployBtn.classList.toggle('active', state.deployed);
  });

  exportBtn.addEventListener('click', () => {
    if (worker) worker.postMessage({ type: 'export' });
    else if (state.latestWeights) downloadWeights(state.latestWeights);
  });

  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      balancer.loadWeights(data);
      state.latestWeights = data;
      if (worker) worker.postMessage({ type: 'load', data });
      deployBtn.disabled = false;
      exportBtn.disabled = false;
      readout.innerHTML = `已加载权重（${data.updates || '?'} 次迭代）`;
    } catch (error) {
      readout.textContent = `权重加载失败: ${error.message}`;
    }
    importInput.value = '';
  });

  deployBtn.disabled = true;
  exportBtn.disabled = true;
  readout.textContent = '未开始训练';

  return { balancer, state };
}
