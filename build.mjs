import * as esbuild from "esbuild";

// Build the adapter (runs at build time in Node.js)
await esbuild.build({
  entryPoints: ["src/adapter.ts"],
  outfile: "dist/adapter.js",
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
});

// Build the cache handler (referenced by next config at build time)
await esbuild.build({
  entryPoints: ["src/cache-handler.ts"],
  outfile: "dist/cache-handler.js",
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
});

console.log("Build complete");
