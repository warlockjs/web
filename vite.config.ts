import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const entryFiles = {
  index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
  "connector/index": fileURLToPath(new URL("./src/connector/index.ts", import.meta.url)),
  "vite/index": fileURLToPath(new URL("./src/vite/index.ts", import.meta.url)),
};

const peerPackages = [
  "@warlock.js/core",
  "@warlock.js/seal",
  "react",
  "react-dom",
  "vite",
] as const;

function isExternalDependency(id: string): boolean {
  if (id.startsWith("node:")) {
    return true;
  }

  return peerPackages.some(
    (packageName) => id === packageName || id.startsWith(`${packageName}/`),
  );
}

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: entryFiles,
      fileName: (_format: string, entryName: string): string => `${entryName}.js`,
      formats: ["es"],
    },
    outDir: "esm",
    rollupOptions: {
      // Peers stay external so consumers share React and the single core ALS identity.
      external: isExternalDependency,
    },
    target: "es2022",
  },
});
