// 面部 LED 点阵：双眼各 7×5 像素 + 2×11 语音条，贴合曲面面罩排布。
// 表情由解析形状函数（圆角矩形、斜切、弧带）逐像素采样得到，可平滑切换颜色、
// 眨眼（行塌缩）、发力闪光与扫描线微光。对外接口与旧版保持一致：
//   setEmotion(name) / flash(strength) / update(dt)
import * as THREE from 'three';

export const EMOTIONS = {
  calm:  { color: 0x35d9ff, intensity: 4.5 },   // 待机：冰蓝
  focus: { color: 0x4f8dff, intensity: 5.0 },   // 行走：深蓝
  power: { color: 0xffa03b, intensity: 6.2 },   // 跑步/跳跃：琥珀
  fury:  { color: 0xff3b55, intensity: 7.0 },   // 功夫：赤红
  zen:   { color: 0x34d399, intensity: 3.6 },   // 八段锦：翠绿
  joy:   { color: 0xff4fd8, intensity: 5.6 },   // 跳舞：霓虹粉
};

const COLS = 7;
const ROWS = 5;
const MOUTH_COLS = 11;
const MOUTH_ROWS = 2;

// u∈[-1,1] 横向（正 = 朝外眼角），w∈[-1,1] 纵向（正 = 上）
const SHAPES = {
  calm: (u, w) => Math.pow(Math.abs(u / 0.86), 4) + Math.pow(Math.abs(w / 1.02), 4) <= 1,
  focus: (u, w) => Math.pow(Math.abs(u / 1.02), 4) + Math.pow(Math.abs(w / 0.55), 4) <= 1,
  power: (u, w) => Math.pow(Math.abs(u / 0.95), 4) + Math.pow(Math.abs(w / 1.02), 4) <= 1
    && w <= 0.45 + 0.45 * u,
  fury: (u, w) => Math.pow(Math.abs(u / 1.02), 4) + Math.pow(Math.abs(w / 1.02), 4) <= 1
    && w <= -0.05 + 0.85 * u,
  zen: (u, w) => Math.abs(u) <= 0.95 && Math.abs(w - (-0.55 + 0.8 * u * u)) <= 0.36,
  joy: (u, w) => Math.abs(u) <= 0.95 && Math.abs(w - (0.45 - 0.9 * u * u)) <= 0.36,
};

/**
 * @param {THREE.Object3D} parent  头部刚体
 * @param {(x:number,y:number)=>{p:THREE.Vector3,n:THREE.Vector3}} surface  面罩曲面采样
 * @param {{eyeY:number, eyeX:number, mouthY:number, pitch:number}} layout
 */
export function buildFace(parent, surface, layout) {
  const { eyeY, eyeX, mouthY, pitch } = layout;
  const pixels = [];   // { side, u, w, mouth, col }
  for (const side of [1, -1]) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const u = (c - (COLS - 1) / 2) / ((COLS - 1) / 2);
        const w = ((ROWS - 1) / 2 - r) / ((ROWS - 1) / 2);
        pixels.push({
          side, u: u * side, w, mouth: false,
          x: side * eyeX + (c - (COLS - 1) / 2) * pitch,
          y: eyeY + w * ((ROWS - 1) / 2) * pitch,
        });
      }
    }
  }
  for (let r = 0; r < MOUTH_ROWS; r++) {
    for (let c = 0; c < MOUTH_COLS; c++) {
      pixels.push({
        side: 0, u: (c - (MOUTH_COLS - 1) / 2) / ((MOUTH_COLS - 1) / 2), w: r === 0 ? 1 : -1,
        mouth: true, col: c,
        x: (c - (MOUTH_COLS - 1) / 2) * pitch * 0.82,
        y: mouthY + (r === 0 ? 0.5 : -0.5) * pitch * 0.8,
      });
    }
  }

  const geo = new THREE.PlaneGeometry(pitch * 0.74, pitch * 0.74);
  const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const mesh = new THREE.InstancedMesh(geo, mat, pixels.length);
  mesh.name = 'face-led-matrix';
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  pixels.forEach((px, i) => {
    const { p, n } = surface(px.x, px.y);
    const scale = px.mouth ? 0.7 : 1;
    q.setFromUnitVectors(zAxis, n);
    m.compose(p.clone().addScaledVector(n, 0.0009), q, new THREE.Vector3(scale, scale * (px.mouth ? 0.55 : 1), 1));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, new THREE.Color(0, 0, 0));
  });
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);

  const tmpColor = new THREE.Color();
  const face = {
    mesh,
    emotion: 'calm',
    _color: new THREE.Color(EMOTIONS.calm.color),
    _targetColor: new THREE.Color(EMOTIONS.calm.color),
    _intensity: EMOTIONS.calm.intensity,
    _targetIntensity: EMOTIONS.calm.intensity,
    _flash: 0,
    _blinkTimer: 2.5,
    _blinkPhase: 0,
    _morph: 1,          // 表情切换过渡（0→1）
    _prevShape: 'calm',
    _t: 0,

    setEmotion(name) {
      const preset = EMOTIONS[name];
      if (!preset || this.emotion === name) return;
      this._prevShape = this.emotion;
      this.emotion = name;
      this._morph = 0;
      this._targetColor.setHex(preset.color);
      this._targetIntensity = preset.intensity;
    },

    /** 短促闪光：动作发力瞬间调用。 */
    flash(strength = 2.2) { this._flash = Math.max(this._flash, strength); },

    update(dt) {
      this._t += dt;
      const k = 1 - Math.exp(-dt / 0.25);
      this._color.lerp(this._targetColor, k);
      this._intensity += (this._targetIntensity - this._intensity) * k;
      this._flash = Math.max(0, this._flash - dt * 6);
      this._morph = Math.min(1, this._morph + dt / 0.22);

      // 眨眼：行向中线塌缩
      let open = 1;
      if (this._blinkPhase > 0) {
        this._blinkPhase = Math.max(0, this._blinkPhase - dt / 0.16);
        open = Math.abs(1 - this._blinkPhase * 2);
      } else {
        this._blinkTimer -= dt;
        if (this._blinkTimer <= 0) {
          this._blinkPhase = 1;
          this._blinkTimer = 2 + Math.random() * 3.5;
        }
      }

      // 按亮度归一：不同色相的表情有一致的视亮度（红色亮度系数低，需要更高的通道值）
      const lum = 0.2126 * this._color.r + 0.7152 * this._color.g + 0.0722 * this._color.b;
      const glow = (this._intensity * 2.6 * (1 + this._flash)) / Math.max(lum, 0.05);
      const shape = this._morph < 0.5 ? SHAPES[this._prevShape] : SHAPES[this.emotion];
      const fade = Math.abs(this._morph - 0.5) * 2;   // 切换时先暗后亮
      const t = this._t;
      pixels.forEach((px, i) => {
        let level;
        if (px.mouth) {
          // 语音条：中间高、两边低的呼吸律动
          const amp = 0.35 + 0.25 * Math.sin(t * 2.1) + 0.2 * Math.sin(t * 5.3 + px.col);
          const env = 1 - Math.abs(px.u) * 0.8;
          level = (px.w > 0 ? amp * env > 0.28 : true) ? 0.55 : 0;
        } else {
          const lit = shape(px.u, px.w) && Math.abs(px.w) <= open + 0.01;
          const scan = 0.88 + 0.12 * Math.sin(t * 5 - px.w * 2.4);
          level = lit ? scan * fade : 0;
        }
        if (level > 0) {
          tmpColor.copy(this._color).multiplyScalar(glow * level);
        } else {
          tmpColor.copy(this._color).multiplyScalar(0.035);   // 熄灭像素仍隐约可见
        }
        mesh.setColorAt(i, tmpColor);
      });
      mesh.instanceColor.needsUpdate = true;
    },
  };
  face.update(0);
  return face;
}
