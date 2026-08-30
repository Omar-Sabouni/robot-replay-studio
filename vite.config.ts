import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

const projectFile = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const workerUrlPlaceholder = '"__ROBOT_REPLAY_ANALYSIS_WORKER_URL__"';

function sharedAnalysisWorker(): Plugin {
  let workerReferenceId: string | undefined;
  return {
    name: "robot-replay-shared-analysis-worker",
    apply: "build",
    buildStart() {
      workerReferenceId = this.emitFile({
        type: "chunk",
        id: projectFile("./src/core/analysis-worker.ts"),
        name: "analysis-worker",
      });
    },
    transform(code, id) {
      if (!id.endsWith("/src/studio.ts")) {
        return null;
      }
      if (workerReferenceId === undefined || !code.includes(workerUrlPlaceholder)) {
        throw new Error("Unable to bind the analysis worker URL into the studio entry");
      }
      return code.replace(workerUrlPlaceholder, `import.meta.ROLLUP_FILE_URL_${workerReferenceId}`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [sharedAnalysisWorker()],
  build: {
    manifest: true,
    modulePreload: { polyfill: false },
    target: "es2022",
    chunkSizeWarningLimit: 650,
  },
  worker: {
    format: "es",
  },
});
