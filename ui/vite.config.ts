import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// During `vite dev`, proxy backend calls to the Hono process on :8080.
// In production the Hono process serves the built static output from
// `ui/dist` directly, so this proxy is dev-only.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/healthz": "http://localhost:8080",
      "/demo": "http://localhost:8080",
      "/chat": "http://localhost:8080",
      "/sessions": "http://localhost:8080",
    },
  },
});
