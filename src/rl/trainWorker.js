// 后台训练 Worker：在独立线程跑 TrainerCore，渲染主线程零卡顿。
// 协议（postMessage）：
//   主 → 工：{type:'start'} | {type:'pause'} | {type:'export'} | {type:'reset'}
//   工 → 主：{type:'stats', ...统计} 每迭代一次
//            {type:'policy', data}  每迭代同步一次最新权重（供实时部署）
//            {type:'weights', data} 响应 export

import { TrainerCore } from './Trainer.js?v=20261002-eng-v1';

let trainer = new TrainerCore();
let running = false;

function loop() {
  if (!running) return;
  const stats = trainer.iterate();
  postMessage({ type: 'stats', ...stats });
  // 同步最优 checkpoint（而非最新策略）：部署质量不受训练后期漂移影响
  postMessage({ type: 'policy', data: trainer.deployWeights() });
  setTimeout(loop, 0);   // 让出事件循环，保证消息能进出
}

onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'start' && !running) {
    running = true;
    loop();
  } else if (msg.type === 'pause') {
    running = false;
  } else if (msg.type === 'export') {
    postMessage({ type: 'weights', data: trainer.deployWeights() });
  } else if (msg.type === 'reset') {
    running = false;
    trainer = new TrainerCore();
    postMessage({ type: 'stats', iter: 0, totalSteps: 0, meanEpReturn: 0, meanEpLen: 0 });
  } else if (msg.type === 'load') {
    trainer.agent.load(msg.data);
  }
};
