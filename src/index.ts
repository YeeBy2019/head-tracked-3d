import * as THREE from "three";
import { Pane } from "tweakpane";
import { HeadTracker } from "./head-tracker";
import {
  HEAD_OFFSET_LIMIT,
  NEUTRAL_DIST,
  POSE_RECENTER_TAU,
  POSE_TAU,
  ROT_LIMIT_DEG,
  ROT_PITCH_RATIO,
  ROT_SIGN,
  SCENE,
} from "./config";
import { createSplatScene } from "./scene";
import { LANG, t } from "./i18n";
import "./main.css";

/**
 * 头追踪 3D 显示。
 *
 * 一条管线：摄像头 → 6DoF 位姿 →  stabilize → 相机平移/旋转 → 渲染。
 * 没有离轴投影、没有"屏幕锚定"——相机就是一个普通的透视相机，
 * 只是它的位置和朝向由你的头决定（理由见 README「为什么不用贴屏投影」）。
 *
 * URL 参数：
 *   ?demo   无摄像头演示模式（合成头部动作，用于预览与录屏）
 *   ?lang   en / zh，覆盖界面语言（默认跟随浏览器首选语言）
 */

document.documentElement.lang = LANG;

const query = new URLSearchParams(location.search);
const demoParam = query.get("demo");

const params = {
  /** 主开关：关掉后相机回到中性位置 */
  headTrack: true,
  /** 无摄像头演示：用合成的头部动作驱动视差 */
  demo: demoParam !== null,
  /** 演示动作的周期（秒）。?demo=6 可以放慢/加快，录屏时用得上 */
  demoPeriod: Number(demoParam) > 0 ? Number(demoParam) : 8,
  /** 在摄像头预览上叠加 478 个关键点（调试） */
  faceMesh: false,
  /** 视差强度：头部平移 → 相机位移的总增益 */
  headGain: 1.0,
  /** 转头跟随：0 = 转头不改视角，1 = 与真实世界 1:1 */
  headRot: 1.0,
  /** 转向上限（度） */
  rotLimitDeg: ROT_LIMIT_DEG,
  /** 视点进退（房间单位，正 = 后退） */
  dolly: SCENE.dolly,
};

// 转头跟随的零点：启动后取前 20 帧有效位姿的平均当"你正对着屏幕"。
// 之后只有按"重新居中"才会动——持续跟踪零点会把用户的操作吃掉（详见 README）。
const rotZero = { yaw: 0, pitch: 0, samples: 0 };
// 实际喂给相机的转角，只用于面板读数
const rotApplied = { yawDeg: 0 };

// —— 状态提示 ——
const statusEl = document.createElement("div");
statusEl.id = "status";
document.body.appendChild(statusEl);

function showStatus(msg: string, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!msg && isError);
  statusEl.classList.toggle("show", !!msg);
}

// —— 场景 ——
const splat = createSplatScene(showStatus);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.add(splat.group);

// near 取 0.01：视点可以贴到家具跟前而不被裁掉。
const FOV = (2 * Math.atan(1 / NEUTRAL_DIST)) * (180 / Math.PI);
const camera = new THREE.PerspectiveCamera(
  FOV,
  window.innerWidth / window.innerHeight,
  0.01,
  100
);
camera.rotation.order = "YXZ";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.domElement.id = "threeCanvas";
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// —— 头部追踪 ——
const headTracker = new HeadTracker();

// 摄像头不可用（没权限 / 非安全上下文 / 没有摄像头）时给一条可见提示。
// 演示模式下不提示：那本来就是给没摄像头的人看的。
setTimeout(() => {
  if (params.demo || !headTracker.error) return;
  const d = document.createElement("div");
  d.id = "alert";
  d.textContent = headTracker.error;
  document.body.appendChild(d);
}, 1500);

// —— 面板 ——

/** 只调整"看起来对不对"的东西；标定值都在 config.ts 里 */
function setupUI() {
  const paneDiv = document.createElement("div");
  paneDiv.id = "pane";
  document.body.appendChild(paneDiv);

  const pane = new Pane({ container: paneDiv }) as any;

  const track = pane.addFolder({ title: t.panel.tracking });
  track
    .addInput(params, "headTrack", { label: t.ui.headTrack })
    .on("change", () => showStatus(""));
  track.addInput(params, "demo", { label: t.ui.demo });
  track.addInput(params, "headGain", {
    min: 0.4,
    max: 3.0,
    step: 0.05,
    label: t.ui.parallax,
  });
  track.addInput(params, "headRot", {
    min: 0,
    max: 2,
    step: 0.05,
    label: t.ui.headRot,
  });
  track.addInput(params, "rotLimitDeg", {
    min: 5,
    max: 70,
    step: 1,
    label: t.ui.rotLimit,
  });
  track.addButton({ title: t.ui.recenter }).on("click", recenterRot);
  track.addMonitor(rotApplied, "yawDeg", {
    label: t.ui.appliedYaw,
    format: (v: number) => v.toFixed(1) + "°",
    interval: 100,
  });

  const sceneFolder = pane.addFolder({ title: t.panel.scene });
  sceneFolder
    .addInput(params, "dolly", {
      min: -1,
      max: 1,
      step: 0.01,
      label: t.ui.dolly,
    })
    .on("change", () => splat.setDolly(params.dolly));

  const debug = pane.addFolder({ title: t.panel.debug, expanded: false });
  debug.addInput(params, "faceMesh", { label: t.ui.faceMesh });

  // H 键收起面板：演示 / 录屏时不想让调试面板入镜
  window.addEventListener("keydown", (e) => {
    if (e.key === "h" || e.key === "H") {
      paneDiv.style.display = paneDiv.style.display === "none" ? "" : "none";
    }
  });
}

setupUI();

function recenterRot() {
  if (!headTracker.ready || !headTracker.pose.valid) return;
  rotZero.yaw = headTracker.pose.yaw;
  rotZero.pitch = headTracker.pose.pitch;
  rotZero.samples = 20; // 标记"已标定"，不再被启动均值覆盖
  // smoothed 不动：让相机顺着低通自己转回正前方，而不是一帧跳回去
}

// —— 演示模式 ——
// 合成的"头部动作"：横向摆幅 20 cm、左右各约 14°，默认 8 秒一循环。
// 三个分量都取同一个基频的整数倍（1× / 2× / 3×），所以整段是**严格周期**的
// —— 首尾相接时没有跳变（README 里那段预览 GIF 就是这么录的）。
function demoPose(t: number) {
  const w = (2 * Math.PI * t) / params.demoPeriod;
  return {
    x: 0.2 * Math.sin(w),
    y: 0.05 * Math.sin(2 * w + 0.9),
    yaw: 0.24 * Math.sin(w),
    pitch: 0.04 * Math.sin(3 * w + 2.1),
  };
}

// —— 渲染循环 ——
// 用 renderer.setAnimationLoop 而非裸 requestAnimationFrame：three 的推荐写法，
// 接入 WebXR 头显时会自动切到原生 XR 帧循环。

// 位姿输出的平滑状态：目标值（检测结果）与实际喂给相机的值分开，
// 一阶低通把任何突变抹成一段滑动。
const smoothed = { x: 0, y: 0, dist: NEUTRAL_DIST, yaw: 0, pitch: 0 };
let prevNow = -1;
// 关键点视图当前状态（只在变化时写 DOM，避免每帧触发样式重算）
let meshOn = false;

/** 只在接近上限时才压缩：常态区间保持 1:1 线性，不做非线性畸变 */
function softLimit(v: number, lim: number): number {
  const knee = 0.8 * lim;
  const a = Math.abs(v);
  if (a <= knee) return v;
  const span = lim - knee;
  return Math.sign(v) * (knee + span * Math.tanh((a - knee) / span));
}

const render = () => {
  const now = performance.now();
  const dt = prevNow < 0 ? 1 / 60 : Math.min(0.1, (now - prevNow) / 1000);
  prevNow = now;

  const demo = params.demo;
  const tracking = params.headTrack && headTracker.ready && headTracker.pose.valid;

  // 驱动检测（内部按 ~30fps 降频）。演示模式不占用摄像头。
  if (params.headTrack && !demo) {
    headTracker.update(now);
  }

  // 摄像头预览：演示模式下藏起来（否则录屏里会多一个黑框）
  const cam = document.getElementById("webcam");
  if (cam) {
    const want = demo ? "none" : "";
    if (cam.style.display !== want) cam.style.display = want;
  }

  // 关键点调试视图：勾选时同时放大预览（否则 478 个点糊成一片）
  const wantMesh = params.faceMesh && params.headTrack && !demo && headTracker.ready;
  if (wantMesh !== meshOn) {
    meshOn = wantMesh;
    headTracker.showLandmarks = wantMesh;
    cam?.classList.toggle("mesh", wantMesh);
  }

  // 零点标定：只在启动后前 20 帧有效位姿上做一次
  if (tracking && rotZero.samples < 20) {
    rotZero.samples++;
    const a = 1 / rotZero.samples;
    rotZero.yaw += (headTracker.pose.yaw - rotZero.yaw) * a;
    rotZero.pitch += (headTracker.pose.pitch - rotZero.pitch) * a;
  }

  let targetX = 0;
  let targetY = 0;
  let targetDist = NEUTRAL_DIST;
  let targetYaw = 0;
  let targetPitch = 0;

  if (demo) {
    const d = demoPose(now / 1000);
    targetX = softLimit(d.x * params.headGain, HEAD_OFFSET_LIMIT);
    targetY = softLimit(d.y * params.headGain, HEAD_OFFSET_LIMIT);
    targetYaw = softLimit(d.yaw * params.headRot, THREE.MathUtils.degToRad(params.rotLimitDeg));
    targetPitch = softLimit(
      d.pitch * params.headRot,
      THREE.MathUtils.degToRad(params.rotLimitDeg) * ROT_PITCH_RATIO
    );
  } else if (tracking) {
    const p = headTracker.pose;
    const g = params.headGain;

    targetX = softLimit(p.offsetX * g, HEAD_OFFSET_LIMIT);
    targetY = softLimit(p.offsetY * g, HEAD_OFFSET_LIMIT);
    targetDist = p.dist;

    // 转头跟随：headRot = 0 时两项都为 0，等于完全不参与。
    // 角度走软限幅 —— 这套数据的覆盖面只在正前方，转过头就是一层糊高斯。
    const rotLim = THREE.MathUtils.degToRad(params.rotLimitDeg);
    targetYaw = softLimit(
      (p.yaw - rotZero.yaw) * ROT_SIGN * params.headRot,
      rotLim
    );
    targetPitch = softLimit(
      (p.pitch - rotZero.pitch) * ROT_SIGN * params.headRot,
      rotLim * ROT_PITCH_RATIO
    );
  }

  // 一阶低通。系数按时间算，掉帧时行为也一致。
  // 跟踪中（含演示）用 POSE_TAU 跟手；丢失后回中用 POSE_RECENTER_TAU 柔和。
  const tau = demo || tracking ? POSE_TAU : POSE_RECENTER_TAU;
  const k = 1 - Math.exp(-dt / tau);
  smoothed.x += (targetX - smoothed.x) * k;
  smoothed.y += (targetY - smoothed.y) * k;
  smoothed.dist += (targetDist - smoothed.dist) * k;
  smoothed.yaw += (targetYaw - smoothed.yaw) * k;
  smoothed.pitch += (targetPitch - smoothed.pitch) * k;

  // 先摆位置再摆朝向：旋转绕自身（眼睛）发生，不改变位置。
  camera.position.set(-smoothed.x, -smoothed.y, smoothed.dist);
  camera.rotation.set(smoothed.pitch, smoothed.yaw, 0);
  rotApplied.yawDeg = THREE.MathUtils.radToDeg(smoothed.yaw);

  renderer.render(scene, camera);
};

renderer.setAnimationLoop(render);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
