import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tauri 约定：固定端口 1420，被占用直接报错（否则 Tauri 窗口白屏）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // foliate-js 的 PDF 适配器按这个名字找它自带的 pdf.js
      "@pdfjs/pdf.min.mjs": fileURLToPath(new URL("./src/vendor/foliate-js/vendor/pdfjs/pdf.mjs", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  // refs/ 是拉下来做参考的第三方仓库，不参与监听和测试
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/refs/**", "**/src-tauri/**", "**/sidecar/**"] } },
  test: { include: ["src/**/*.test.ts"] },
  build: { target: "esnext" },
  worker: { format: "es" },
});
