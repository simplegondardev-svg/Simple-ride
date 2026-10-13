// MapLibre v6 loads its web worker from a separate ES module next to its main
// file. Bundlers rename that file, so the default worker URL 404s and the map
// never loads tiles. Serve the worker from public/ instead (Map.tsx calls
// setWorkerUrl). Runs before dev/build so the copy always matches the
// installed maplibre-gl version.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(require.resolve("maplibre-gl/package.json")), "dist");
const out = path.join(import.meta.dirname, "..", "public", "maplibre");
mkdirSync(out, { recursive: true });
copyFileSync(path.join(dist, "maplibre-gl-worker.mjs"), path.join(out, "maplibre-gl-worker.mjs"));
