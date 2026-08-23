import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served as static assets by the server at /ui/* in production
// ("web/ read-only supervision UI") — `base`
// keeps built asset URLs correct under that prefix.
export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin in prod (server serves both); in dev, forward API calls
      // to the backend so there's no CORS story to build at all.
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
