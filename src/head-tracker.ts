import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { OneEuroFilter } from "./math-helper";
import { PoseStabilizer, type RawPose, type StablePose } from "./pose-stabilizer";
import { headAngles } from "./pose-math";
import { NEUTRAL_DIST } from "./config";
import { t } from "./i18n";

// MediaPipe Tasks Vision 的 wasm 运行时与模型（CDN 加载，无需本地打包）
const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// 检测降频：头部运动慢，无需每帧推理（约 30fps 足够）
const DETECT_INTERVAL_MS = 33;

// 边缘带：人脸包围盒中心进入距画面边界 EDGE_MARGIN（归一化）的窄带内，
// 就算"快出画了"——此时 landmark 已经严重畸变，给出来的值不可信。
// 具体的迟滞与保持逻辑在 pose-stabilizer.ts 里。
const EDGE_MARGIN = 0.08;

// 478 点模型中左右虹膜中心的关键点索引
const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;

async function setupWebcam(): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { width: 640, height: 480 },
  });
  video.srcObject = stream;

  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play();
      resolve(video);
    };
  });
}

export interface HeadPose {
  // 归一化屏幕偏移（范围约 -1..1），x 右、y 上为正
  offsetX: number;
  offsetY: number;
  // 相机到屏幕的距离（世界单位），由 6DoF 矩阵估算的深度
  dist: number;
  // 头部朝向（弧度）：yaw = 左右转头，pitch = 抬头/低头。
  // 注意：默认这两个值**不参与**视角计算（鱼缸模型里屏幕是固定的，
  // 转头不该改变屏幕上的内容）。只有 index.ts 的"转头跟随"滑杆 > 0 时才用。
  yaw: number;
  pitch: number;
  // 原始 4x4 位姿矩阵（列主序，length 16），供高级用法
  matrix: number[] | null;
  // 位姿可用（含"丢帧保持"期间的保持值）
  valid: boolean;
  // 这一帧其实没检测到，输出是保持来的
  held: boolean;
}

/**
 * 头部追踪器（现代实现）。
 *
 * 升级点：
 * - 用 @mediapipe/tasks-vision 的 FaceLandmarker 取代旧的 TFJS FaceMesh 封装；
 * - 启用 facialTransformationMatrixes，拿到完整的 6DoF 位姿矩阵；
 * - 用 6DoF 矩阵的平移量（cm）取代旧的 ipd 像素间距距离近似，
 *   头部转动/俯仰时距离估计更稳定；
 * - 时序平滑从固定 α EMA 升级为自适应 One Euro Filter；
 * - 推理由主循环驱动（update），便于与渲染循环合并与降频。
 *
 * 注：原项目其实已用 predictIrises 取虹膜点，本次升级本质是用更新模型
 * (478 vs 468+10) + 真实位姿矩阵取代 ipd 距离启发式，并非"从无到有加虹膜"。
 */
export class HeadTracker {
  private faceLandmarker: FaceLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  ready = false;
  error: string | null = null;

  // 对外暴露的位姿，每帧由 index.ts 读取
  pose: HeadPose = {
    offsetX: 0,
    offsetY: 0,
    dist: NEUTRAL_DIST,
    yaw: 0,
    pitch: 0,
    matrix: null,
    valid: false,
    held: false,
  };

  // HUD / 降级显示用（沿用原字段名）
  centralPupil: number[] = [0, 0];
  ipd: number = 100;

  // 是否在摄像头预览上叠加 478 个面部关键点（调试视图，面板复选框驱动）
  showLandmarks = false;

  // 每个分量独立滤波：x/y 用较高截止（横向移动快），dist 用较低截止
  // 注意 beta 的单位：这里的信号是"归一化人脸位置"（约 -1..1），其导数
  // 就是"每秒移动多少个归一化单位"——快速转头时能到 2~3/s，所以 beta 要比
  // 经典示例（信号本身在 0..1 且缓慢变化）大一个量级，才能真正把延迟压下去。
  private fx = new OneEuroFilter(1.5, 6.0, 1.0);
  private fy = new OneEuroFilter(1.5, 6.0, 1.0);
  private fdist = new OneEuroFilter(1.0, 1.0, 1.0);
  // 角度用弧度做单位：快速转头约 3.5 rad/s，beta 相应放大
  private fyaw = new OneEuroFilter(1.2, 2.5, 1.0);
  private fpitch = new OneEuroFilter(1.2, 2.5, 1.0);

  // 失稳处理（丢帧保持 / 边缘迟滞 / 跳变拒绝）全在这里，见 pose-stabilizer.ts
  private stab = new PoseStabilizer({ neutralDist: NEUTRAL_DIST });

  // 标定常量：6DoF 平移量（MediaPipe 以 cm 计）→ 眼睛到虚拟屏幕的距离。
  // 参考：人脸距相机 refFaceCm 时，窗口距离 = NEUTRAL_DIST。
  private refFaceCm = 60;

  private lastDetect = 0;

  constructor() {
    this.init();
  }

  private async init() {
    try {
      const [landmarker, video] = await Promise.all([
        this.loadModel(),
        setupWebcam(),
      ]);
      this.faceLandmarker = landmarker;
      this.video = video;

      this.canvas = document.createElement("canvas");
      this.canvas.id = "webcam";
      this.canvas.width = video.videoWidth;
      this.canvas.height = video.videoHeight;
      document.body.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.ready = true;
    } catch (e: any) {
      this.error =
        e && e.name === "NotAllowedError"
          ? t.status.cameraDenied
          : t.status.initFailed(e?.message ?? String(e));
      console.error(e);
    }
  }

  private async loadModel(): Promise<FaceLandmarker> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      // 默认阈值是 0.5，侧脸/半张脸出画时会直接判为"没有脸"，
      // 表现就是转到某个角度画面突然复位。调低到 0.3 让检测在边缘多撑一会儿，
      // 真正不可信的那部分由下面 estimate() 的边缘态 + 保持逻辑兜住。
      minFaceDetectionConfidence: 0.3,
      minFacePresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });
  }

  /** 由主循环每帧调用；内部按 DETECT_INTERVAL_MS 降频推理。ts 为 performance.now()。 */
  update(ts: number) {
    if (!this.ready || !this.faceLandmarker || !this.video || !this.ctx) return;
    if (ts - this.lastDetect < DETECT_INTERVAL_MS) return;
    this.lastDetect = ts;

    const result = this.faceLandmarker.detectForVideo(this.video, ts);
    this.estimate(result, ts);
  }

  private estimate(result: FaceLandmarkerResult, ts: number) {
    const ctx = this.ctx!;
    const video = this.video!;

    // 预览：镜像交给 CSS（#webcam { transform: scaleX(-1) }），这里原样绘制
    ctx.drawImage(video, 0, 0, this.canvas!.width, this.canvas!.height);

    const lm = result.faceLandmarks?.[0];

    // 没有检测到人脸：把 null 交给稳定器，由它按"丢帧保持"处理。
    // 这里**不**直接把 valid 置 false —— 那是原来"画面一帧跳回正中"的根源。
    if (!lm) {
      this.commit(this.stab.step(null), null);
      this.drawInfo();
      return;
    }

    // 虹膜中心（归一化 0..1）→ 归一化屏幕偏移 -1..1
    const li = lm[LEFT_IRIS];
    const ri = lm[RIGHT_IRIS];
    if (li && ri) {
      const cx = ((li.x + ri.x) * 0.5) * 2 - 1;
      const cy = ((li.y + ri.y) * 0.5) * 2 - 1;
      this.centralPupil[0] = cx;
      this.centralPupil[1] = -cy; // 图像 y 向下，取反为"上为正"

      const ipdPx = Math.hypot(li.x - ri.x, li.y - ri.y) * this.canvas!.width;
      this.ipd = this.ipd * 0.9 + ipdPx * 0.1; // 轻量 EMA 仅用于 HUD
    }

    // 6DoF 矩阵 → 真实距离 + 头部朝向。
    // MediaPipe 的 facialTransformationMatrix 是刚性变换（旋转块正交、无尺度），
    // 所以不能用列向量长度估距离——平移量（cm）才是相机到人脸的真实位移。
    let matrix: number[] | null = null;
    let distFromMatrix: number | null = null;
    let rawYaw = 0;
    let rawPitch = 0;
    const mats = result.facialTransformationMatrixes;
    if (mats && mats.length > 0) {
      const m = mats[0].data; // length 16
      matrix = Array.from(m);
      // 判定位移所在位置：列主序时在 12..14（末行 3/7/11 应为 0）；
      // 若为行主序则相反。避免平台/版本布局差异导致距离恒为 0。
      const columnMajor =
        Math.abs(m[3]) < 1e-3 &&
        Math.abs(m[7]) < 1e-3 &&
        Math.abs(m[11]) < 1e-3;
      const tz = columnMajor ? m[14] : m[11];
      let faceCm = Math.abs(tz);
      if (faceCm > 0 && faceCm < 5) faceCm *= 100; // 防御：若矩阵单位是米
      if (faceCm > 5) {
        distFromMatrix = (NEUTRAL_DIST * faceCm) / this.refFaceCm;
      }

      // 归一化成"yaw>0 = 转向用户自己的左边、pitch>0 = 抬头"，
      // 与矩阵是哪种下标/朝向约定无关（判定见 pose-math.ts）
      const e = headAngles(m);
      rawYaw = e.yaw;
      rawPitch = e.pitch;
    }

    const offsetX = this.fx.filter(this.centralPupil[0], ts);
    const offsetY = this.fy.filter(this.centralPupil[1], ts);
    const distRaw = distFromMatrix !== null ? distFromMatrix : NEUTRAL_DIST;
    const dist = Math.max(0.7, Math.min(4, this.fdist.filter(distRaw, ts)));
    const yaw = this.fyaw.filter(rawYaw, ts);
    const pitch = this.fpitch.filter(rawPitch, ts);

    // 交给稳定器：它负责边缘迟滞 / 丢帧保持 / 跳变拒绝，
    // 任何情况下都不会吐出"相比上一帧突变"的结果。
    const raw: RawPose = { offsetX, offsetY, dist, yaw, pitch };
    this.commit(this.stab.step(raw, this.isNearEdge(lm)), matrix);
    if (this.showLandmarks) this.drawLandmarks(lm);
    this.drawInfo();
  }

  /**
   * 在摄像头预览上叠加 478 个关键点与若干轮廓（调试视图）。
   *
   * 轮廓比散点有用得多：散点看着都差不多，只有连成脸型/眼睛/虹膜之后，
   * "landmark 有没有跑偏、脸是不是已经被画面切掉"才一眼看得出来 —— 这恰好是
   * 边缘闪烁问题的现场证据。虹膜用红色圆点单独标出，因为 offsetX/offsetY
   * 就是由它俩算出来的。
   */
  private drawLandmarks(lm: { x: number; y: number }[]) {
    const ctx = this.ctx!;
    const w = this.canvas!.width;
    const h = this.canvas!.height;

    const groups: [{ start: number; end: number }[], string][] = [
      [FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, "rgba(50, 238, 219, 0.5)"],
      [FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, "rgba(50, 238, 219, 0.5)"],
      [FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, "rgba(50, 238, 219, 0.5)"],
      [FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, "rgba(255, 209, 102, 0.95)"],
      [FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, "rgba(255, 209, 102, 0.95)"],
      [FaceLandmarker.FACE_LANDMARKS_LIPS, "rgba(255, 120, 170, 0.6)"],
    ];

    ctx.lineWidth = 1;
    for (const [conns, color] of groups) {
      if (!conns || conns.length === 0) continue;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const c of conns) {
        const a = lm[c.start];
        const b = lm[c.end];
        if (!a || !b) continue;
        ctx.moveTo(a.x * w, a.y * h);
        ctx.lineTo(b.x * w, b.y * h);
      }
      ctx.stroke();
    }

    // 478 个点用 fillRect 而不是 arc：同样的视效，快一个量级，30fps 下差别明显
    ctx.fillStyle = "rgba(50, 238, 219, 0.85)";
    for (let i = 0; i < lm.length; i++) {
      ctx.fillRect(lm[i].x * w - 1, lm[i].y * h - 1, 2, 2);
    }

    // 虹膜中心：offsetX / offsetY 的直接来源，单独标出来
    ctx.fillStyle = "#ff5252";
    for (const idx of [LEFT_IRIS, RIGHT_IRIS]) {
      const p = lm[idx];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 稳定器只产出几何量；matrix 单独挂在外面，供高级用法读取 */
  private commit(p: StablePose, matrix: number[] | null) {
    this.pose = { ...p, matrix: matrix ?? this.pose.matrix };
  }

  /**
   * 人脸是否已经贴到画面边缘。
   *
   * 用 landmark 包围盒的中心判断，而不是"有没有检测到"——因为 MediaPipe 在
   * 人脸被画面边界切掉一半时，仍然会返回一整张脸的 landmark，只是形状被严重
   * 拉伸，算出来的偏移和角度都是错的。这时候"有检测结果"反而是最坏的情况：
   * 值在"勉强正确"和"完全错乱"之间反复横跳，就是肉眼看到的闪烁。
   *
   * 迟滞逻辑不在这里，交给 PoseStabilizer —— 那边才有连续帧的概念。
   */
  private isNearEdge(lm: { x: number; y: number }[]): boolean {
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    for (let i = 0; i < lm.length; i++) {
      const p = lm[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    return (
      cx < EDGE_MARGIN ||
      cx > 1 - EDGE_MARGIN ||
      cy < EDGE_MARGIN ||
      cy > 1 - EDGE_MARGIN
    );
  }

  private drawInfo() {
    const ctx = this.ctx!;
    const fontSize = 22;
    ctx.font = `${fontSize}px arial`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#32EEDB";
    ctx.fillText(`IPD=${this.ipd.toFixed(0)}`, this.canvas!.width * 0.5, fontSize);
    ctx.fillText(
      `Pose=(${this.pose.offsetX.toFixed(2)}, ${this.pose.offsetY.toFixed(
        2
      )}, d${this.pose.dist.toFixed(1)})`,
      this.canvas!.width * 0.5,
      fontSize * 2
    );

    // 朝向 + 状态：调"转头跟随"时看这行判断符号对不对
    const deg = 180 / Math.PI;
    const state = !this.pose.valid ? "LOST" : this.pose.held ? "HOLD" : "";
    ctx.fillStyle = state === "LOST" ? "#ff9f43" : "#32EEDB";
    ctx.fillText(
      `Yaw=${(this.pose.yaw * deg).toFixed(0)}°  Pitch=${(this.pose.pitch * deg).toFixed(
        0
      )}°  ${state}`,
      this.canvas!.width * 0.5,
      fontSize * 3
    );

    if (this.error) {
      ctx.fillStyle = "#ff6b6b";
      ctx.fillText(this.error, this.canvas!.width * 0.5, fontSize * 4);
    }
  }
}
