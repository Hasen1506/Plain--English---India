import { defineConfig } from "vite";

// The frontend lives in web/. Relative base so it works at https://<user>.github.io/<repo>/.
export default defineConfig(({ mode }) => ({
  root: "web",
  base: mode === "e2e" ? "/" : "./",
  publicDir: false,
  build: { outDir: mode === "e2e" ? "../dist-e2e" : "../dist", emptyOutDir: true, sourcemap: true, target: "es2022" },
  define: mode === "e2e" ? { "import.meta.env.VITE_E2E": JSON.stringify("1") } : {},
}));
