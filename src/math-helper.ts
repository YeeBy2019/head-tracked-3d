import seedrandom from "seedrandom";

const rng = seedrandom("abc");

export function random(min = 0, max = 1) {
  return min + rng() * (max - min);
}

/**
 * One Euro Filter — 自适应低通滤波器。
 *
 * 相比固定 α 的指数移动平均（EMA），它的截止频率会随信号变化率自适应：
 * - 信号静止时 → 低截止频率 → 强平滑、消除抖动；
 * - 信号快速变化时 → 高截止频率 → 低延迟、无"拖拽感"。
 *
 * 经典实现见 Casiez, Roussel, Vogel (2012), "1€ Filter".
 */
export class OneEuroFilter {
  private yPrev = 0;
  private dPrev = 0;
  private tPrev = 0;
  private initialized = false;

  constructor(
    private minCutoff = 1.2, // 最小截止频率（静止时的平滑强度）
    private beta = 0.02, // 斜率增益（越大，快速运动时延迟越低）
    private dCutoff = 1.0 // 导数低通的截止频率
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, timestampMs: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.yPrev = value;
      this.tPrev = timestampMs;
      return value;
    }

    let dt = (timestampMs - this.tPrev) / 1000;
    if (dt <= 0 || !isFinite(dt)) dt = 1 / 60;

    // 一阶微分（速度估计）
    const d = (value - this.yPrev) / dt;
    // 对导数本身再做一次低通：必须用"上一帧的滤波后导数"，否则 a*d+(1-a)*d 恒等于 d，
    // 等于没有滤波——噪声会让 cutoff 被 beta*|d| 顶到极大，滤波器直接失效。
    const aD = this.alpha(this.dCutoff, dt);
    const dHat = aD * d + (1 - aD) * this.dPrev;
    this.dPrev = dHat;

    // 自适应截止频率：速度越大，截止越高
    const cutoff = this.minCutoff + this.beta * Math.abs(dHat);
    const a = this.alpha(cutoff, dt);

    const y = a * value + (1 - a) * this.yPrev;
    this.yPrev = y;
    this.tPrev = timestampMs;
    return y;
  }

  reset(): void {
    this.initialized = false;
    this.yPrev = 0;
    this.dPrev = 0;
    this.tPrev = 0;
  }
}
