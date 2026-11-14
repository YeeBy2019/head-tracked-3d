/**
 * 位姿矩阵的几何解算。
 *
 * 单独成一个模块，是为了能脱离 MediaPipe（和浏览器）在 Node 里直接跑测试：
 * 这里的每个符号都会直接变成"头往左转、画面往哪边转"，靠肉眼验证太慢。
 * 测试见 `.workbuddy/tools/test-rotation.cjs`。
 *
 * ## 为什么不能直接 asin(R02)
 *
 * 一是矩阵在部分平台/版本上**旋转块里带缩放**，asin 会提前饱和 → 角度算小；
 * 二是更麻烦的一点：MediaPipe 的矩阵把"标准脸模型"映射到相机坐标系，
 * 而**相机看 +Z 还是 -Z** 决定了静止时它到底是单位阵还是绕 Y 转 180°。
 * 两种情况算出来的 yaw 会**整体差一个符号**，表现就是"往左转头画面往右转"。
 *
 * 这里不靠猜：用平移量的正负（脸在相机前方还是后方）判断相机朝向，
 * 再用头的"上"向量判断 y 轴朝上还是朝下，两种都self-consistent地归一成
 *   yaw > 0 = 头转向用户自己的左边
 *   pitch > 0 = 抬头
 * 这样上层只管 `camera.rotation.y = yaw`，不用管矩阵的约定。
 */

/** 从 4x4 位姿矩阵判定布局：列主序时末行（下标 3/7/11）为 0 */
export function isColumnMajor(m: ArrayLike<number>): boolean {
  return Math.abs(m[3]) < 1e-3 && Math.abs(m[7]) < 1e-3 && Math.abs(m[11]) < 1e-3;
}

/**
 * 提取**用户视角**的头部朝向：
 *   yaw   > 0 → 头转向用户自己的左边
 *   pitch > 0 → 抬头
 *
 * 同时返回原始的旋转块（已归一化），供需要自己算别的量的地方使用。
 */
export function headAngles(m: ArrayLike<number>): {
  yaw: number;
  pitch: number;
} {
  const columnMajor = isColumnMajor(m);
  const at = (r: number, c: number) => (columnMajor ? m[c * 4 + r] : m[r * 4 + c]);

  // 逐列归一化：矩阵的旋转块在部分版本里带缩放，不归一化时 asin 会提前饱和，
  // 算出来的角度比实际小 —— 表现就是"头转了不少，画面只转一点点"。
  const len = (c: number) => Math.hypot(at(0, c), at(1, c), at(2, c)) || 1;
  const [l0, l1, l2] = [len(0), len(1), len(2)];
  const R = (r: number, c: number) => at(r, c) / (c === 0 ? l0 : c === 1 ? l1 : l2);

  // 脸的正前方 = 标准模型 +Z 轴在相机坐标里的方向，即旋转矩阵第三列
  const fx = R(0, 2);
  const fy = R(1, 2);
  const fz = R(2, 2);
  // 头的"上" = 标准模型 +Y 轴，即第二列
  const uy = R(1, 1);

  // 相机看 +Z 还是 -Z：脸在 z>0 一侧时，静止的正脸朝向 -Z；反之朝向 +Z。
  // 这一步把"静止是单位阵还是绕 Y 转 180°"这个 50/50 的约定消掉了。
  const tz = columnMajor ? m[14] : m[11];
  const zRest = tz > 0 ? -1 : 1;
  // 同理，y 轴朝上还是朝下（OpenCV 系是朝下）
  const yRest = uy >= 0 ? 1 : -1;

  const yaw = Math.atan2(fx, fz * zRest);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fy * yRest)));
  return { yaw, pitch };
}

const DEG = 180 / Math.PI;
export { DEG };
