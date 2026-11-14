import * as THREE from "three";
// 3D Gaussian Splatting 渲染库（无官方 TS 类型，按 any 接入）。
// DropInViewer 把它包装成一个可加入普通 three 场景的 Object3D，
// 从而复用我们自己的相机与投影——头追踪视差直接作用于照片级真实空间。
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { NEUTRAL_DIST, SCENE } from "./config";
import { fetchSplatBlob } from "./splat-source";
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

  void loadScene();

  async function loadScene() {
    onStatus(t.status.loading(SCENE.label, null));
    let objectUrl: string | null = null;
    try {
      const blob = await fetchSplatBlob(SCENE.url, {
        expectedBytes: SCENE.bytes,
        onProgress: (pct) => onStatus(t.status.loading(SCENE.label, pct)),
      });
      // 先落到内存再交给库：库拿到的是一次本地读取，
      // 网络抖动只影响上面这段，重试与进度都在我们自己手上。
      objectUrl = URL.createObjectURL(blob);
      await viewer.addSplatScene(objectUrl, {
        // blob: URL 没有扩展名，库靠后缀猜格式会直接报"不支持"，
        // 所以这里必须显式声明是 SPZ。
        format: (GaussianSplats3D as any).SceneFormat.Spz,
        showLoadingUI: false,
        splatAlphaRemovalThreshold: 5,
      });
      onStatus("");
    } catch (err) {
      console.error(err);
      onStatus(t.status.loadFailed(SCENE.label), true);
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  return { group, setDolly };
}
