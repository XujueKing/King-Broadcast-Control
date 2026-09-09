import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        output: resolve(import.meta.dirname, "output.html"),
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    allowedHosts: ["terminal.local", "localhost"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
    watch: {
      // Native Windows file watching becomes unreliable in this project once
      // model caches, Python environments and media evidence are present.
      // Poll only the small source tree so the desktop UI cannot turn white
      // because the Vite watcher stopped unexpectedly.
      usePolling: true,
      interval: 350,
      ignored: [
        "**/node_modules/**",
        "**/.venv*/**",
        "**/.local-tools/**",
        "**/src-tauri/target/**",
        "**/vendor/**",
        "**/tmp/**",
        "**/artifacts/**",
        "**/dist/**",
        "**/models/**",
        "**/media/**",
      ],
    },
  },
  plugins: [react()],
});
