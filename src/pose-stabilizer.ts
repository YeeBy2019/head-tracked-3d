/**
 * 位姿稳定器：把"检测器的原始输出"变成"能直接喂给相机的位姿"。
 *
 * 单独抽出来的原因有两个：
 *  1. 这三件事（丢帧保持 / 边缘迟滞 / 跳变拒绝）是纯状态机，和 MediaPipe 无关，
 *     拆开之后可以在 Node 里用一串伪造的检测结果直接跑，验证"不会闪"；
 *  2. 它们是同一个问题的三张网，写在一起才看得出彼此的关系：
 *
 *     检测器在画面边缘的行为是"时有时无 + 值不可信"，于是：
 *       - 边缘迟滞：先把"快出画"这个状态本身做成有记忆的，单帧抖动不翻转；
 *       - 丢帧保持：真的没检测到时，短时间内沿用上一次的有效位姿（画面不动）；
 *       - 跳变拒绝：检测到但值离谱时，当作没检测到，走同一条保持路径。
 *
 *     三者最终都收敛到"要么保持、要么标记失效"，绝不会产生一帧突变。
 */

export interface RawPose {
  offsetX: number;
  offsetY: number;
  dist: number;
  yaw: number;
  pitch: number;
}

export interface StablePose extends RawPose {
  /** 位姿可用（含"保持"期间沿用的旧值） */
  valid: boolean;
  /** 这一帧其实没有可用的检测结果，输出是保持来的 */
  held: boolean;
}

export interface StabilizerOptions {
  /** 短于这个帧数的丢失，直接沿用上一次有效位姿 */
  holdFrames: number;
  /** 连续多少帧贴边才认定"进入边缘"（默认 1：宁可早冻结） */
  edgeEnter: number;
  /** 连续多少帧不贴边才认定"离开边缘"（默认 6：防止边界抖动反复解冻） */
  edgeExit: number;
  /** 单帧跳变阈值：超过就当作识别错乱 */
  jumpXY: number;
  jumpDist: number;
  jumpRot: number;
  /** dist 的中性值 */
  neutralDist: number;
}

const DEFAULTS: StabilizerOptions = {
  // 30fps 检测下 10 帧 ≈ 330ms
  holdFrames: 10,
  // 进入只要 1 帧：贴边时 landmark 已经不可信，晚一帧就多一帧错值
  edgeEnter: 1,
  // 离开要 6 帧：边界附近 nearEdge 会反复翻转，解冻太快就又闪回去了
  edgeExit: 6,
  jumpXY: 0.3,
  jumpDist: 0.8,
  jumpRot: 0.7,
  neutralDist: 1.6,
};

export class PoseStabilizer {
  private readonly opt: StabilizerOptions;

  private lostFrames = 0;
  private edgeHits = 0;
  private edgeClear = 0;
  private inEdge = false;
  private hold: RawPose | null = null;

  private _pose: StablePose;

  constructor(options: Partial<StabilizerOptions> = {}) {
    this.opt = { ...DEFAULTS, ...options };
    this._pose = {
      offsetX: 0,
      offsetY: 0,
      dist: this.opt.neutralDist,
      yaw: 0,
      pitch: 0,
      valid: false,
      held: false,
    };
  }

  get pose(): StablePose {
    return this._pose;
  }

  /**
   * 送入一帧检测结果。
   *
   * @param raw      解算出的原始位姿；没检测到人脸时传 null
   * @param nearEdge 人脸是否已经贴到画面边缘（raw 为 null 时忽略）
   */
  step(raw: RawPose | null, nearEdge = false): StablePose {
    this.updateEdge(raw, nearEdge);

    // —— ① 检测到了，但脸贴在画面边缘 ——
    // landmark 被画面边界切掉一半，算出来的值不可信；但人确实还在镜头里。
    // 这种时候**无限期冻结**最后可靠的位置：回中会变成"头转了但画面没反应"，
    // 比冻结更迷惑；而继续用这些畸变的值，就是原来那种来回闪。
    // 注意不累加 lostFrames —— 贴边不是"丢"，一回到中间就该立刻恢复跟随。
    if (raw && this.inEdge) {
      this.lostFrames = 0;
      return this.holdPose();
    }

    // —— ② 真丢帧 / 值离谱 ——
    // 有限期保持，超时后标记失效，由渲染端平滑回中（人离开镜头了，归位是合理的）。
    if (!raw || this.isJump(raw)) {
      this.lostFrames++;

      if (this.hold && this.lostFrames <= this.opt.holdFrames) {
        return this.holdPose();
      }

      // 清空 hold 是为了让重新捕获的第一帧能被直接接受，不会一直被跳变判据拒绝
      this.hold = null;
      this._pose = { ...this._pose, valid: false, held: true };
      return this._pose;
    }

    // —— ③ 正常接受 ——
    this.lostFrames = 0;
    this.hold = { ...raw };
    this._pose = { ...raw, valid: true, held: false };
    return this._pose;
  }

  /** 沿用上一次有效位姿；从没拿到过有效值时就保持当前（初始为中性、invalid） */
  private holdPose(): StablePose {
    if (!this.hold) {
      this._pose = { ...this._pose, valid: false, held: true };
      return this._pose;
    }
    this._pose = { ...this.hold, valid: true, held: true };
    return this._pose;
  }

  /**
   * 边缘状态的迟滞。
   *
   * 不对称：进 1 帧（贴边时 landmark 已经不可信，晚一帧就是多一帧错值），
   * 出 6 帧（边界附近判定会反复翻转，解冻太快又会闪回去）。
   * "宁可早冻结、晚解冻"——冻结的代价是画面停一下，解冻太早的代价是闪烁。
   */
  private updateEdge(raw: RawPose | null, nearEdge: boolean) {
    if (!raw) return;

    if (nearEdge) {
      this.edgeHits++;
      this.edgeClear = 0;
      if (this.edgeHits >= this.opt.edgeEnter) this.inEdge = true;
    } else {
      this.edgeClear++;
      this.edgeHits = 0;
      if (this.edgeClear >= this.opt.edgeExit) this.inEdge = false;
    }
  }

  /** 单帧变化大到不可能来自真实头部运动（33ms 内）→ 判为识别错乱 */
  private isJump(raw: RawPose | null): boolean {
    const h = this.hold;
    if (!raw || !h) return false;
    return (
      Math.abs(raw.offsetX - h.offsetX) > this.opt.jumpXY ||
      Math.abs(raw.offsetY - h.offsetY) > this.opt.jumpXY ||
      Math.abs(raw.dist - h.dist) > this.opt.jumpDist ||
      Math.abs(raw.yaw - h.yaw) > this.opt.jumpRot ||
      Math.abs(raw.pitch - h.pitch) > this.opt.jumpRot
    );
  }

  reset() {
    this.lostFrames = 0;
    this.edgeHits = 0;
    this.edgeClear = 0;
    this.inEdge = false;
    this.hold = null;
    this._pose = {
      offsetX: 0,
      offsetY: 0,
      dist: this.opt.neutralDist,
      yaw: 0,
      pitch: 0,
      valid: false,
      held: false,
    };
  }
}
