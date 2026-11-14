import * as THREE from "three";
// 3D Gaussian Splatting 渲染库（无官方 TS 类型，按 any 接入）。
// DropInViewer 把它包装成一个可加入普通 three 场景的 Object3D，
// 从而复用我们自己的相机与投影——头追踪视差直接作用于照片级真实空间。
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { NEUTRAL_DIST, SCENE } from "./config";
import { t } from "./i18n";

type StatusFn = (msg: string, isError?: boolean) => void;

export interface SplatScene {
  /** 加入主场景的容器 */
  group: THREE.Group;
  /** 视点沿视线进退（房间单位，正 = 后退） */
  setDolly(v: number): void;
}

/**
 * 加载 3DGS 房间，并把它摆到"视点正好站在 anchor 上"的位置。
 *
 * 摆放逻辑（改朝向/缩放时视点不能漂）：
 *   世界坐标 = R · (anchor × scale) + T
 * 要求 anchor 落到中性相机位置 (0, 0, NEUTRAL_DIST)，于是
 *   T = (0, 0, NEUTRAL_DIST) − R · (anchor × scale)
 * 因为只有 z 会随 dolly 变，x/y 的平移是常量，可以一次算完。
 */
export function createSplatScene(onStatus: StatusFn): SplatScene {
  const group = new THREE.Group();

  const scale = SCENE.scale;
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(SCENE.pitch),
      THREE.MathUtils.degToRad(SCENE.yaw),
      0,
      "YXZ"
    )
  );

  // anchor 经过缩放 + 旋转后的世界偏移（与 dolly 无关）
  const a = SCENE.anchor.clone().multiplyScalar(scale).applyQuaternion(quat);

  const viewer: any = new (GaussianSplats3D as any).DropInViewer({
    // 关掉 Worker 里的 SharedArrayBuffer 排序路径，从而无需 crossOriginIsolated
    //（COOP/COEP 头），避免 DataCloneError，也不影响 MediaPipe 从 CDN 加载。
    sharedMemoryForWorkers: false,
  });
  viewer.rotation.order = "YXZ";
  viewer.rotation.copy(new THREE.Euler().setFromQuaternion(quat, "YXZ"));
  viewer.scale.setScalar(scale);
  group.add(viewer);

  function setDolly(dolly: number) {
    group.position.set(
      -a.x,
      -a.y,
      NEUTRAL_DIST - a.z + dolly * scale
    );
  }
  setDolly(SCENE.dolly);

  onStatus(t.status.loading(SCENE.label, null));
  viewer
    .addSplatScene(SCENE.url, {
      showLoadingUI: false,
      splatAlphaRemovalThreshold: 5,
      onProgress: (e: any) => {
        const p =
          e && typeof e.progress === "number"
            ? e.progress
            : e && typeof e.percent === "number"
              ? e.percent
              : null;
        if (p != null) {
          onStatus(t.status.loading(SCENE.label, Math.round(p * 100)));
        }
      },
    })
    .then(() => onStatus(""))
    .catch((err: any) => {
      console.error(err);
      onStatus(t.status.loadFailed(SCENE.url), true);
    });

  return { group, setDolly };
}
