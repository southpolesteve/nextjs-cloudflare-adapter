/**
 * Cloudflare Worker entry point for Next.js
 *
 * Uses the cloudflare:node httpServerHandler API to bridge Worker fetch()
 * requests directly to the Next.js standalone Node.js HTTP server.
 *
 * The Next.js standalone server.js calls http.createServer + listen().
 * Workers registers that server internally, and httpServerHandler forwards
 * incoming fetch requests to it.
 *
 * Requires:
 *   - nodejs_compat compatibility flag
 *   - compatibility_date >= 2025-08-15
 *
 * @see https://blog.cloudflare.com/bringing-node-js-http-servers-to-cloudflare-workers/
 */

import { httpServerHandler } from "cloudflare:node";

interface Env {
  ASSETS: {
    fetch(request: Request | string | URL): Promise<Response>;
  };
  NEXT_CACHE?: any;
  NEXT_BUILD_ID?: string;
  [key: string]: unknown;
}

const NEXT_SERVER_PORT = 3000;

let serverReady = false;
let initPromise: Promise<void> | null = null;
let initError: Error | null = null;
let nodeServerHandler:
  | {
      fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
      ): Promise<Response>;
    }
  | null = null;

/**
 * Boot the Next.js standalone server (runs once per isolate).
 *
 * The standalone server.js sets process.env, requires("next"), calls
 * startServer() which internally does http.createServer().listen(port).
 * Workers intercepts that listen() call and registers the server.
 */
async function bootNextServer(env: Env): Promise<void> {
  if (serverReady) return;
  if (initError) throw initError;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Populate process.env from Worker env bindings
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
          (process.env as any)[key] = value;
        }
      }

      // Override the port so the standalone server listens on our known port
      (process.env as any).PORT = String(NEXT_SERVER_PORT);
      (process.env as any).HOSTNAME = "localhost";
      (process.env as any).NODE_ENV = "production";

      // Prevent adapter hooks from running at request time
      delete (process.env as any).NEXT_ADAPTER_PATH;

      // Import the standalone server.js, which boots Next.js
      // This file is placed alongside worker.js in the output directory
      const serverModule = await import("./server.js");
      const boot = serverModule.default?.boot || serverModule.boot;
      const server = await boot();
      nodeServerHandler = httpServerHandler(server);

      serverReady = true;
    } catch (err) {
      initError = err as Error;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Determine whether a request should be served from static assets.
 */
function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith("/_next/static/")) return true;
  if (pathname === "/favicon.ico") return true;

  const staticExts = new Set([
    ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".webp", ".avif", ".map",
    ".txt", ".xml", ".webmanifest",
  ]);

  const lastDot = pathname.lastIndexOf(".");
  if (lastDot > 0) {
    return staticExts.has(pathname.substring(lastDot));
  }

  return false;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // 1. Serve static assets from the ASSETS binding (CDN edge)
    if (isStaticAsset(url.pathname)) {
      try {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) {
          return assetResponse;
        }
      } catch {
        // Fall through to Next.js
      }
    }

    // 2. Boot the Next.js server (lazy, once per isolate)
    try {
      await bootNextServer(env);
    } catch (err: any) {
      console.error("[nextjs-cloudflare] Failed to boot Next.js:", err);
      return new Response(
        "Internal Server Error: Next.js failed to start\n\n" + String(err),
        { status: 500, headers: { "content-type": "text/plain" } }
      );
    }

    if (!nodeServerHandler) {
      return new Response("Internal Server Error: Node handler not initialized", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }

    // 3. Forward the request to the Next.js Node.js HTTP server
    return nodeServerHandler.fetch(request, env, ctx);
  },
};
