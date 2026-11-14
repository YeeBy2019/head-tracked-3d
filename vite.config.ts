import { defineConfig } from "vite";

// Vite 替代原 webpack 配置。构建产物输出到 /docs（与 README 中 GitHub Pages 用法一致）。
export default defineConfig({
  base: "./",
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
  server: {
    port: 8000,
    open: true,
  },
});
