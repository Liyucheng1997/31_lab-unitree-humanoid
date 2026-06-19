// Web Audio 实时合成：以 D 宫五声音阶写成的古琴/洞箫风格慢板。
// 不依赖外部音频文件，首次启动必须来自用户点击以符合浏览器自动播放策略。
const BPM = 72;
const BEAT = 60 / BPM;
const SCALE = [0, 2, 4, 7, 9]; // 宫、商、角、徵、羽
const MELODY = [
  0, 2, 4, 2, 1, 0, -1, null, 0, 1, 2, 4, 2, 1, 0, null,
  4, 3, 2, 1, 2, 4, 5, null, 4, 2, 1, 0, -1, 0, 1, null,
];

function scaleFrequency(step, octave = 0) {
  const degree = ((step % 5) + 5) % 5;
  const oct = Math.floor(step / 5) + octave;
  return 293.66 * Math.pow(2, (SCALE[degree] + oct * 12) / 12); // D4 为宫
}

export class ClassicalMusic {
  constructor() {
    this.context = null;
    this.master = null;
    this.timer = null;
    this.nextNoteTime = 0;
    this.note = 0;
    this.playing = false;
    this.muted = false;
  }

  async start() {
    if (!this.context) this.init();
    await this.context.resume();
    if (this.playing) return;
    this.playing = true;
    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.setTargetAtTime(this.muted ? 0.0001 : 0.24, this.context.currentTime, 0.04);
    this.note = 0;
    this.nextNoteTime = this.context.currentTime + 0.08;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 100);
  }

  stop() {
    this.playing = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    if (this.master && this.context) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.12);
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master && this.context)
      this.master.gain.setTargetAtTime(muted ? 0.0001 : 0.24, this.context.currentTime, 0.08);
  }

  init() {
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.context.createGain();
    this.master.gain.value = 0.24;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2800;
    filter.Q.value = 0.7;
    this.master.connect(filter).connect(this.context.destination);
  }

  schedule() {
    if (!this.playing) return;
    while (this.nextNoteTime < this.context.currentTime + 0.5) {
      const value = MELODY[this.note % MELODY.length];
      if (value !== null) this.playNote(scaleFrequency(value), this.nextNoteTime, BEAT * 1.65);
      if (this.note % 4 === 0) this.playDrone(scaleFrequency(this.note % 16 < 8 ? -5 : -3), this.nextNoteTime);
      this.note++;
      this.nextNoteTime += BEAT;
    }
  }

  playNote(freq, time, duration) {
    const gain = this.context.createGain();
    const flute = this.context.createOscillator();
    const breath = this.context.createOscillator();
    flute.type = 'sine';
    breath.type = 'triangle';
    flute.frequency.setValueAtTime(freq, time);
    breath.frequency.setValueAtTime(freq * 2.002, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.22, time + 0.09);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    flute.connect(gain); breath.connect(gain); gain.connect(this.master);
    flute.start(time); breath.start(time);
    flute.stop(time + duration + 0.05); breath.stop(time + duration + 0.05);
  }

  playDrone(freq, time) {
    const gain = this.context.createGain();
    const string = this.context.createOscillator();
    string.type = 'triangle';
    string.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.09, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + BEAT * 3.5);
    string.connect(gain).connect(this.master);
    string.start(time); string.stop(time + BEAT * 3.6);
  }
}
