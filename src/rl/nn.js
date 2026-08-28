// 极简神经网络库：多层感知机 + 手写反向传播 + Adam。
// 零依赖纯 JS，为 rsl_rl 风格的 PPO（见 ppo.js）提供 actor / critic 网络。
// 规模（10→64→64→2）下逐样本标量运算完全够快，无需 WebGL/tfjs。

/** 可复现的伪随机数发生器（mulberry32）。 */
export function makeRng(seed = 42) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态采样（Box-Muller）。 */
export function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class Linear {
  constructor(inDim, outDim, rng) {
    this.inDim = inDim;
    this.outDim = outDim;
    // 正交初始化的廉价近似：缩放高斯（tanh 网络的常用做法）。
    const scale = Math.sqrt(2 / inDim);
    this.w = new Float64Array(inDim * outDim);
    this.b = new Float64Array(outDim);
    for (let i = 0; i < this.w.length; i++) this.w[i] = gaussian(rng) * scale;
    this.gw = new Float64Array(inDim * outDim);
    this.gb = new Float64Array(outDim);
    // Adam 状态
    this.mw = new Float64Array(this.w.length);
    this.vw = new Float64Array(this.w.length);
    this.mb = new Float64Array(outDim);
    this.vb = new Float64Array(outDim);
  }
}

/**
 * 多层感知机：隐藏层 tanh，输出层线性。
 * 训练用法（逐样本）：forward(x) → backward(dOut) 累积梯度 → adamStep()。
 */
export class MLP {
  constructor(sizes, seed = 42) {
    this.sizes = sizes;
    const rng = makeRng(seed);
    this.layers = [];
    for (let i = 0; i < sizes.length - 1; i++) {
      this.layers.push(new Linear(sizes[i], sizes[i + 1], rng));
    }
    // 输出层用小初始化，起步策略接近零动作。
    const last = this.layers[this.layers.length - 1];
    for (let i = 0; i < last.w.length; i++) last.w[i] *= 0.1;
    // forward 激活缓存（backward 用）
    this.acts = sizes.map((n) => new Float64Array(n));
    this.adamT = 0;
  }

  forward(x) {
    const a0 = this.acts[0];
    for (let i = 0; i < a0.length; i++) a0[i] = x[i];
    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      const src = this.acts[l];
      const dst = this.acts[l + 1];
      const lastLayer = l === this.layers.length - 1;
      for (let j = 0; j < layer.outDim; j++) {
        let sum = layer.b[j];
        const off = j * layer.inDim;
        for (let i = 0; i < layer.inDim; i++) sum += layer.w[off + i] * src[i];
        dst[j] = lastLayer ? sum : Math.tanh(sum);
      }
    }
    return this.acts[this.acts.length - 1];
  }

  /** 反传 dLoss/dOutput，累积权重梯度。必须紧跟对应样本的 forward。 */
  backward(dOut) {
    let delta = Float64Array.from(dOut);
    for (let l = this.layers.length - 1; l >= 0; l--) {
      const layer = this.layers[l];
      const src = this.acts[l];
      const dSrc = new Float64Array(layer.inDim);
      for (let j = 0; j < layer.outDim; j++) {
        const d = delta[j];
        if (d === 0) continue;
        layer.gb[j] += d;
        const off = j * layer.inDim;
        for (let i = 0; i < layer.inDim; i++) {
          layer.gw[off + i] += d * src[i];
          dSrc[i] += d * layer.w[off + i];
        }
      }
      if (l > 0) {
        // 穿过上一层的 tanh：dtanh = 1 - a²
        for (let i = 0; i < dSrc.length; i++) {
          const a = src[i];
          dSrc[i] *= 1 - a * a;
        }
      }
      delta = dSrc;
    }
  }

  zeroGrad() {
    for (const layer of this.layers) {
      layer.gw.fill(0);
      layer.gb.fill(0);
    }
  }

  /** Adam 更新（梯度已按 batch 平均或调用方自行缩放）。 */
  adamStep(lr, scale = 1, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
    this.adamT += 1;
    const c1 = 1 - Math.pow(beta1, this.adamT);
    const c2 = 1 - Math.pow(beta2, this.adamT);
    for (const layer of this.layers) {
      for (let i = 0; i < layer.w.length; i++) {
        const g = layer.gw[i] * scale;
        layer.mw[i] = beta1 * layer.mw[i] + (1 - beta1) * g;
        layer.vw[i] = beta2 * layer.vw[i] + (1 - beta2) * g * g;
        layer.w[i] -= lr * (layer.mw[i] / c1) / (Math.sqrt(layer.vw[i] / c2) + eps);
      }
      for (let i = 0; i < layer.b.length; i++) {
        const g = layer.gb[i] * scale;
        layer.mb[i] = beta1 * layer.mb[i] + (1 - beta1) * g;
        layer.vb[i] = beta2 * layer.vb[i] + (1 - beta2) * g * g;
        layer.b[i] -= lr * (layer.mb[i] / c1) / (Math.sqrt(layer.vb[i] / c2) + eps);
      }
    }
  }

  /** 清空 Adam 动量（从 checkpoint 恢复时防止旧动量再次推飞权重）。 */
  resetAdam() {
    this.adamT = 0;
    for (const layer of this.layers) {
      layer.mw.fill(0); layer.vw.fill(0);
      layer.mb.fill(0); layer.vb.fill(0);
    }
  }

  /** 导出/导入权重（JSON 可序列化）。 */
  getParams() {
    return this.layers.map((l) => ({ w: Array.from(l.w), b: Array.from(l.b) }));
  }

  setParams(params) {
    params.forEach((p, i) => {
      this.layers[i].w.set(p.w);
      this.layers[i].b.set(p.b);
    });
  }
}
