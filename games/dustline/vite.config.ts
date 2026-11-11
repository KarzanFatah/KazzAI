import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run build` produces one self-contained dist/index.html (easy to share or host anywhere).
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 2000,
  },
});
