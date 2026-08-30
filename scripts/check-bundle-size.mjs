import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const assetDirectory = fileURLToPath(new URL("../dist/assets/", import.meta.url));
const manifestPath = fileURLToPath(new URL("../dist/.vite/manifest.json", import.meta.url));

if (!existsSync(assetDirectory) || !existsSync(manifestPath)) {
  throw new Error(
    "The production assets or Vite manifest do not exist. Run `npm run build` before checking bundle sizes.",
  );
}

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function measure(path) {
  const bytes = readFileSync(path);
  return {
    filename: relative(assetDirectory, path),
    raw: bytes.byteLength,
    gzip: gzipSync(bytes).byteLength,
  };
}

const allAssets = collectFiles(assetDirectory);
const javascriptAssets = allAssets.filter((path) => /\.(?:m?js)$/u.test(path)).map(measure);
const cssAssets = allAssets.filter((path) => path.endsWith(".css")).map(measure);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const appEntryKeys = Object.entries(manifest)
  .filter(([key, entry]) => entry.isEntry === true && key.endsWith(".html"))
  .map(([key]) => key);
const workerEntryKeys = Object.entries(manifest)
  .filter(
    ([key, entry]) =>
      entry.isEntry === true &&
      (key.endsWith("/analysis-worker.ts") || entry.name === "analysis-worker"),
  )
  .map(([key]) => key);
const sceneEntryKeys = Object.entries(manifest)
  .filter(
    ([key, entry]) =>
      entry.isDynamicEntry === true && (key.endsWith("/scene.ts") || entry.name === "scene"),
  )
  .map(([key]) => key);

function includeManifestClosure(key, files, visited) {
  if (visited.has(key)) {
    return;
  }
  visited.add(key);
  const entry = manifest[key];
  if (entry === undefined) {
    throw new Error(`Vite manifest references missing entry ${key}.`);
  }
  if (typeof entry.file === "string" && /\.(?:m?js)$/u.test(entry.file)) {
    files.add(entry.file.replace(/^assets\//u, ""));
  }
  for (const importedKey of entry.imports ?? []) {
    includeManifestClosure(importedKey, files, visited);
  }
}

const initialFiles = new Set();
const visitedInitialEntries = new Set();
for (const key of appEntryKeys) {
  includeManifestClosure(key, initialFiles, visitedInitialEntries);
}

const workerFiles = new Set();
const visitedWorkerEntries = new Set();
for (const key of workerEntryKeys) {
  includeManifestClosure(key, workerFiles, visitedWorkerEntries);
}

const sceneFiles = new Set();
const visitedSceneEntries = new Set();
for (const key of sceneEntryKeys) {
  includeManifestClosure(key, sceneFiles, visitedSceneEntries);
}
for (const filename of initialFiles) {
  sceneFiles.delete(filename);
}

const initialAssets = javascriptAssets.filter(({ filename }) => initialFiles.has(filename));
const workerAssets = javascriptAssets.filter(({ filename }) => workerFiles.has(filename));
const sceneAssets = javascriptAssets.filter(({ filename }) => sceneFiles.has(filename));
const featureAssets = javascriptAssets.filter(
  (asset) =>
    !initialFiles.has(asset.filename) &&
    !workerFiles.has(asset.filename) &&
    !sceneFiles.has(asset.filename),
);

if (initialAssets.length === 0) {
  throw new Error("Expected at least one initial JavaScript asset in dist/assets.");
}

if (sceneAssets.length === 0) {
  throw new Error(
    `Expected a lazy scene bundle; found ${javascriptAssets.map(({ filename }) => filename).join(", ")}.`,
  );
}

if (workerAssets.length === 0) {
  throw new Error("Expected an analysis worker entry and its manifest closure in dist/assets.");
}

if (cssAssets.length === 0) {
  throw new Error("Expected at least one CSS asset in dist/assets.");
}

const sum = (assets, key) => assets.reduce((total, asset) => total + asset[key], 0);
const kibibytes = (value) => value * 1024;
const checks = [
  {
    label: "initial JavaScript",
    bytes: sum(initialAssets, "gzip"),
    limit: kibibytes(60),
  },
  {
    label: "lazy Three.js scene",
    bytes: sum(sceneAssets, "gzip"),
    limit: kibibytes(155),
  },
  {
    label: "worker JavaScript",
    bytes: sum(workerAssets, "gzip"),
    limit: kibibytes(35),
  },
  {
    label: "total JavaScript",
    bytes: sum(javascriptAssets, "gzip"),
    limit: kibibytes(235),
  },
  {
    label: "CSS (minified)",
    bytes: sum(cssAssets, "raw"),
    limit: kibibytes(40),
    unit: "raw",
  },
  {
    label: "CSS",
    bytes: sum(cssAssets, "gzip"),
    limit: kibibytes(12),
    unit: "gzip",
  },
];

const failures = [];

for (const { label, bytes, limit, unit = "gzip" } of checks) {
  const status = bytes <= limit ? "PASS" : "FAIL";
  console.log(
    `${status} ${label.padEnd(22)} ${(bytes / 1024).toFixed(2).padStart(7)} KiB / ${(
      limit / 1024
    ).toFixed(unit === "raw" ? 2 : 0)} KiB ${unit}`,
  );
  if (bytes > limit) {
    failures.push(
      `${label} exceeds its ${unit} budget by ${((bytes - limit) / 1024).toFixed(2)} KiB`,
    );
  }
}

const formatAssets = (assets) =>
  assets.length === 0
    ? "none"
    : assets
        .map(({ filename, gzip }) => `${basename(filename)} (${(gzip / 1024).toFixed(2)} KiB gzip)`)
        .join(", ");

console.log(`Initial: ${formatAssets(initialAssets)}`);
console.log(`Features: ${formatAssets(featureAssets)}`);
console.log(`Scene:   ${formatAssets(sceneAssets)}`);
console.log(`Workers: ${formatAssets(workerAssets)}`);
console.log(`Styles:  ${formatAssets(cssAssets)}`);

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}
