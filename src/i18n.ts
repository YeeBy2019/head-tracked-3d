/**
 * 极简 i18n：只有中文 / 英文两套文案，按浏览器首选语言自动选择。
 *
 * 判定规则刻意做得很窄：只看 navigator.languages[0]（首选语言），
 * 以 "zh" 开头才用中文，其余一律英文 —— 也就是默认英文。
 * 不往列表深处找，是因为"系统首选日语、第二语言英语"的人期望的是英文界面，
 * 而不是被更靠后的 zh 抢走。
 *
 * 覆盖方式：?lang=zh / ?lang=en（录屏、截图、分享固定语言的链接时用）。
 */

export type Lang = "zh" | "en";

export const LANG: Lang = (() => {
  const forced = new URLSearchParams(location.search).get("lang");
  if (forced === "zh" || forced === "en") return forced;

  const preferred =
    (navigator.languages && navigator.languages[0]) || navigator.language || "";
  return /^zh/i.test(preferred) ? "zh" : "en";
})();

const zh = {
  panel: {
    tracking: "追踪",
    scene: "场景",
    debug: "调试",
  },
  ui: {
    headTrack: "头部追踪",
    demo: "演示模式（无摄像头）",
    parallax: "视差强度",
    headRot: "转头跟随",
    rotLimit: "转向上限°",
    recenter: "重新居中",
    appliedYaw: "实际转角",
    dolly: "视点进退",
    faceMesh: "显示面部关键点",
  },
  status: {
    loading: (label: string, pct: number | null) =>
      pct == null ? `正在加载 ${label} …` : `正在加载 ${label} … ${pct}%`,
    loadFailed: (label: string) =>
      `场景下载失败：${label} 在网络中断后仍未能取回，请检查网络或代理后刷新页面。`,
    cameraDenied:
      "摄像头权限被拒绝：请在浏览器地址栏允许摄像头访问后刷新页面。",
    initFailed: (msg: string) => `无法初始化头部追踪：${msg}`,
  },
};

const en: typeof zh = {
  panel: {
    tracking: "Tracking",
    scene: "Scene",
    debug: "Debug",
  },
  ui: {
    headTrack: "Head tracking",
    demo: "Demo (no camera)",
    parallax: "Parallax",
    headRot: "Follow head turn",
    rotLimit: "Rotation limit",
    recenter: "Recenter",
    appliedYaw: "Applied yaw",
    dolly: "Dolly in / out",
    faceMesh: "Face landmarks",
  },
  status: {
    loading: (label, pct) =>
      pct == null ? `Loading ${label} …` : `Loading ${label} … ${pct}%`,
    loadFailed: (label) =>
      `Could not download ${label} — the connection kept dropping. Check your network or proxy, then reload.`,
    cameraDenied:
      "Camera permission denied — allow camera access in the address bar, then reload.",
    initFailed: (msg) => `Could not start head tracking: ${msg}`,
  },
};

/** 当前语言的文案表；两套结构完全一致，键名即语义 */
export const t = LANG === "zh" ? zh : en;
