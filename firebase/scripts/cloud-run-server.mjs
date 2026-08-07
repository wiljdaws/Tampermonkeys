import http from "node:http";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";

import {
  PLAYLISTS_WITH_WINS,
  buildLeaderboardCaches,
  getGcloudAccessToken,
} from "./build-leaderboard-cache.mjs";
import { readR2ConfigFromEnv, uploadJson } from "./upload-to-r2.mjs";

// Minimal HTTP server for Cloud Run. Exposes /health and /rebuild endpoints
// that rebuild leaderboard JSON blobs from Firestore and push them to R2.
// Keep this file dependency-free (`http` only) so the container image stays
// small — the same reason we hand-rolled SigV4 in upload-to-r2.mjs.

export const DEFAULT_PORT = 8080;
export const DEFAULT_PROJECT = "rgleaderboard";
export const DEFAULT_DEBOUNCE_MS = 15_000;
export const DEFAULT_JSON_PREFIX = "leaderboard/";

// A "cheap" tri-state auth check that accepts either an x-rebuild-secret
// header or a ?token= query param, so we can trigger from GCP Cloud
// Scheduler (which prefers query params) and from Firestore triggers
// (which prefer headers).
export function requestIsAuthorized(req, url, expectedSecret) {
  if (!expectedSecret) return false;
  const headerSecret = req.headers?.["x-rebuild-secret"];
  if (typeof headerSecret === "string" && headerSecret === expectedSecret) {
    return true;
  }
  const token = url.searchParams.get("token");
  if (token && token === expectedSecret) return true;
  return false;
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function textResponse(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
  });
  res.end(body);
}

// Debounce store — resolves to `remainingMs > 0` when the caller is inside
// the cooldown window, forcing a 429 response. Callers are responsible for
// calling `recordRun` on success.
export function createDebouncer(intervalMs = DEFAULT_DEBOUNCE_MS, clock = () => Date.now()) {
  const lastRun = new Map();
  return {
    check(key) {
      const previous = lastRun.get(key) || 0;
      const remaining = intervalMs - (clock() - previous);
      return remaining > 0 ? remaining : 0;
    },
    record(key) {
      lastRun.set(key, clock());
    },
    reset() {
      lastRun.clear();
    },
    // Test-only helper.
    _internal: { lastRun },
  };
}

async function readRequestBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function rebuildPlaylists(config, playlists) {
  const startedAt = Date.now();
  const result = await config.buildLeaderboardCaches({
    project: config.project,
    apply: false,
    playlists,
    fetchImpl: config.fetchImpl,
    getToken: config.getToken,
    includeIconKey: false,
    emitJson: true,
    skipFirestore: true,
    jsonPrefix: config.jsonPrefix,
    uploadJsonImpl: config.uploadJson,
  });
  const ms = Date.now() - startedAt;
  const summary = {};
  for (const blob of result.jsonBlobs) {
    summary[blob.playlist] = {
      key: blob.key,
      rowCount: blob.blob.rowCount,
      sourceHash: blob.blob.sourceHash,
      builtAt: blob.blob.builtAt,
    };
  }
  return { ms, playlists: summary, uploads: result.uploads };
}

export function createHandler(config) {
  return async function handler(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    // Health check — public, unauthenticated.
    if (req.method === "GET" && url.pathname === "/health") {
      textResponse(res, 200, "ok");
      return;
    }
    // Rebuild endpoints require a valid secret.
    if (req.method === "POST" && (url.pathname === "/rebuild" || url.pathname.startsWith("/rebuild/"))) {
      if (!requestIsAuthorized(req, url, config.rebuildSecret)) {
        jsonResponse(res, 401, { error: "unauthorized" });
        return;
      }
      // Drain the request body even if we don't care about it — Cloud Run
      // proxies expect the socket to be read.
      await readRequestBody(req).catch(() => {});

      let playlists;
      let debounceKey = "all";
      if (url.pathname === "/rebuild") {
        playlists = [...config.playlists];
      } else {
        const requested = url.pathname.slice("/rebuild/".length);
        if (!config.playlists.includes(requested)) {
          jsonResponse(res, 400, {
            error: "unknown playlist",
            playlist: requested,
            allowed: config.playlists,
          });
          return;
        }
        playlists = [requested];
        debounceKey = requested;
      }

      const remaining = config.debouncer.check(debounceKey);
      if (remaining > 0) {
        res.setHeader("retry-after", String(Math.ceil(remaining / 1000)));
        jsonResponse(res, 429, {
          error: "debounced",
          retryAfterMs: remaining,
          key: debounceKey,
        });
        return;
      }

      try {
        const result = await rebuildPlaylists(config, playlists);
        config.debouncer.record(debounceKey);
        // Also record the per-playlist debounce so /rebuild/{p} right after
        // /rebuild doesn't stampede.
        for (const playlist of playlists) {
          config.debouncer.record(playlist);
        }
        jsonResponse(res, 200, result);
      } catch (error) {
        const message = error?.message || String(error);
        // Don't leak stack traces to the caller — Cloud Run logs get the
        // full thing via the console.error below.
        console.error(`rebuild failed for ${debounceKey}: ${message}`);
        jsonResponse(res, 500, { error: "rebuild_failed", message });
      }
      return;
    }
    // Anything else -> 404.
    jsonResponse(res, 404, { error: "not_found", path: url.pathname });
  };
}

export function resolveConfig(env = process.env, overrides = {}) {
  const port = Number(env.PORT) || DEFAULT_PORT;
  const rebuildSecret = env.REBUILD_SHARED_SECRET || "";
  const project = env.FIREBASE_PROJECT || DEFAULT_PROJECT;
  const jsonPrefix = env.LEADERBOARD_JSON_PREFIX || DEFAULT_JSON_PREFIX;
  const debounceMs = Number(env.REBUILD_DEBOUNCE_MS) || DEFAULT_DEBOUNCE_MS;
  const playlists = env.LEADERBOARD_PLAYLISTS
    ? env.LEADERBOARD_PLAYLISTS.split(",").map(value => value.trim()).filter(Boolean)
    : [...PLAYLISTS_WITH_WINS];
  // Validate the R2 config eagerly so container startup fails loudly when
  // env vars are missing — quieter than discovering it on the first
  // request. In tests we bypass this via overrides.uploadJson.
  if (!overrides.uploadJson) {
    readR2ConfigFromEnv(env);
  }
  return {
    port,
    project,
    jsonPrefix,
    playlists,
    rebuildSecret,
    buildLeaderboardCaches:
      overrides.buildLeaderboardCaches || buildLeaderboardCaches,
    getToken: overrides.getToken || getGcloudAccessToken,
    fetchImpl: overrides.fetchImpl || globalThis.fetch,
    uploadJson: overrides.uploadJson || uploadJson,
    debouncer: overrides.debouncer || createDebouncer(debounceMs),
  };
}

export function createServer(overrides = {}) {
  const config = resolveConfig(process.env, overrides);
  const handler = createHandler(config);
  const server = http.createServer((req, res) => {
    handler(req, res).catch(error => {
      console.error(`unhandled error: ${error?.stack || error}`);
      if (!res.headersSent) jsonResponse(res, 500, { error: "internal_error" });
    });
  });
  return { server, config };
}

export async function main() {
  const { server, config } = createServer();
  if (!config.rebuildSecret) {
    console.warn(
      "warn: REBUILD_SHARED_SECRET is empty — /rebuild will reject every request",
    );
  }
  await new Promise(resolve => server.listen(config.port, resolve));
  console.log(
    `cloud-run-server listening on :${config.port}`
      + ` project=${config.project}`
      + ` playlists=${config.playlists.join(",")}`
      + ` jsonPrefix=${config.jsonPrefix}`,
  );
  // Cloud Run sends SIGTERM ~10s before the container is killed. Close the
  // server so in-flight rebuilds get a chance to finish.
  const shutdown = signal => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
