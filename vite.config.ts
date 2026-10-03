import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 约定：固定端口 1420，被占用直接报错（否则 Tauri 窗口白屏）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "esnext" },
  // pdfjs 的 worker 需要单独打包，这里用 ?url 引入，见 src/lib/parse.ts
  worker: { format: "es" },
});
