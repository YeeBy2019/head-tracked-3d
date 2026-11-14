/**
 * 场景文件的自备下载器。
 *
 * 为什么不用库自带的加载：
 *   1. 它是一条不带重试的 fetch 流，网络抖一下整份文件就白下了，
 *      报出来只有一句 "Could not load file"，看不出是网络问题还是文件不存在；
 *   2. 它的进度回调签名在不同版本间变过（0.4.7 是 (percent, label, chunk, size)），
 *      照旧签名取值只会拿到 undefined，面板上永远没有百分比。
 *
 * 做法是先把文件下成 Blob，再交给库一个 blob: URL。库拿到的变成一次本地读取，
 * 网络问题就只剩这一处，进度和重试都能自己做。
 *
 * 不做 Range 断点续传：GitHub Pages 会把 .splat 当 octet-stream 实时 gzip，
 * 而 Range 命中的是压缩流上的偏移（实测在 1 MB 处取到的字节与原文对不上），
 * 拼接会得到坏数据。宁可整份重下——重试次数有限，不会无限重连。
 */

export interface DownloadOptions {
  /**
   * 文件预期字节数，用来算百分比。
   * 不能用响应的 Content-Length：传输被 gzip 时它给的是压缩后的大小，
   * 而流里读出来的是解压后的字节数，两个数对不上，百分比会冲到 200%。
   */
  expectedBytes?: number;
  /** 整份重下的次数（不含首次） */
  retries?: number;
  onProgress?: (pct: number | null) => void;
}

export async function fetchSplatBlob(
  url: string,
  opts: DownloadOptions = {}
): Promise<Blob> {
  const { expectedBytes, retries = 2, onProgress } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await downloadOnce(url, expectedBytes, onProgress);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // 退避一下再重来，避免服务端刚断连就立刻又扑上去
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function downloadOnce(
  url: string,
  expectedBytes: number | undefined,
  onProgress: ((pct: number | null) => void) | undefined
): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }

  // 极老的浏览器 / 被裁剪的响应：拿不到流，只能整体读
  if (!res.body) {
    const blob = await res.blob();
    onProgress?.(100);
    return blob;
  }

  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  let lastTick = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;

    const now = performance.now();
    if (onProgress && now - lastTick > 100) {
      lastTick = now;
      onProgress(
        expectedBytes
          ? Math.min(99, Math.round((received / expectedBytes) * 100))
          : null
      );
    }
  }

  onProgress?.(100);
  return new Blob(chunks, { type: "application/octet-stream" });
}
