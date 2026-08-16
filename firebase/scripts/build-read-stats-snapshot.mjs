#!/usr/bin/env node
// DISABLED. The Reads tab is gone. A 15-min / 60-day scan of
// admin_read_stats is what blew Spark on 2026-08-15, and the
// date >= query still shows up in Query Insights if this script runs.
// Keep the helpers for tests; run() must not touch Firestore.
//
// Usage:
//   node scripts/build-read-stats-snapshot.mjs --state-dir path/to/site-repo/state
//
// Auth: same as build-leaderboard-cache.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getGcloudAccessToken } from "./build-leaderboard-cache.mjs";
import { decodeFirestoreDocument } from "./snapshot-production.mjs";

// Matches the Reads tab default (today + 6 days back). Wider windows
// made the daily scan itself the top Firestore reader.
export const WINDOW_DAYS = 7;
export const ADMIN_COLLECTION = "admin_read_stats";
export const HUD_COLLECTION = "hud_read_stats";
export const TOTAL_COLLECTION = "read_stats_total";
export const VISITOR_COLLECTION = "visitor_read_stats";
export const OUTPUT_FILENAME = "read-stats.json";

export function parseArgs(argv) {
  const args = {
    project: "rgleaderboard",
    stateDir: "",
    windowDays: WINDOW_DAYS,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--state-dir") args.stateDir = argv[++i];
    else if (a === "--window-days") args.windowDays = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "build-read-stats-snapshot.mjs --state-dir <path> [--project rgleaderboard] [--window-days 30] [--dry-run]",
      );
      process.exit(0);
    }
  }
  return args;
}

// Roll back N days from today's UTC date and return "YYYY-MM-DD".
export function windowStartIso(windowDays, now = new Date()) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - (windowDays - 1));
  return d.toISOString().slice(0, 10);
}

function documentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
}

async function firestorePost(fetchImpl, token, url, body, project) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Goog-User-Project": project,
    },
    body: JSON.stringify(body),
    redirect: "error",
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = parsed?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return parsed;
}

// date is a string like "2026-08-09", so a string range filter works.
export async function queryReadStatsCollection(
  fetchImpl,
  token,
  project,
  collection,
  windowStart,
) {
  const body = await firestorePost(
    fetchImpl,
    token,
    `${documentsBase(project)}:runQuery`,
    {
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: {
          fieldFilter: {
            field: { fieldPath: "date" },
            op: "GREATER_THAN_OR_EQUAL",
            value: { stringValue: windowStart },
          },
        },
      },
    },
    project,
  );
  const docs = [];
  for (const entry of body || []) {
    if (!entry?.document) continue;
    const decoded = decodeFirestoreDocument(entry.document);
    docs.push({ ...decoded.fields, id: decoded.id });
  }
  return docs;
}

// adminEmail never leaves Firestore. Client renders "—" instead.
export function redactAdminDoc(doc) {
  const out = { ...doc };
  delete out.adminEmail;
  return out;
}

export function buildSnapshot({
  siteDocs,
  hudDocs,
  totalDocs = [],
  visitorDocs = [],
  windowDays,
  windowStart,
  windowEnd,
  now = new Date(),
}) {
  return {
    generatedAt: now.toISOString(),
    windowDays,
    windowStart,
    windowEnd,
    site: siteDocs.map(redactAdminDoc),
    hud: hudDocs,
    // Firestore-project-wide daily totals from the Cloud Monitoring cron
    // (one doc per UTC day). Small — a 7-day window is ≤ 7 docs.
    total: totalDocs,
    // Anonymous clan-site visitor sessions. One doc per visitor per day.
    // adminEmail isn't set on these but redact defensively in case a
    // future writer starts populating a similarly-named field.
    visitors: visitorDocs.map(redactAdminDoc),
  };
}

export const READ_STATS_SNAPSHOT_DISABLED = true;

export async function run({
  argv = process.argv.slice(2),
  fetchImpl = globalThis.fetch,
  getToken = getGcloudAccessToken,
  now = new Date(),
  writer = writeFile,
  mkdirImpl = mkdir,
  logger = console,
} = {}) {
  if (READ_STATS_SNAPSHOT_DISABLED) {
    logger.info?.("[read-stats-snapshot] disabled — not querying Firestore");
    return { disabled: true };
  }
  const args = parseArgs(argv);
  if (!args.stateDir) {
    throw new Error("build-read-stats-snapshot: --state-dir is required");
  }
  const windowEnd = now.toISOString().slice(0, 10);
  const windowStart = windowStartIso(args.windowDays, now);
  logger.info?.(
    `[read-stats-snapshot] window ${windowStart} → ${windowEnd} (${args.windowDays}d)`,
  );

  const token = await getToken();
  const [siteDocs, hudDocs, totalDocs, visitorDocs] = await Promise.all([
    queryReadStatsCollection(fetchImpl, token, args.project, ADMIN_COLLECTION, windowStart),
    queryReadStatsCollection(fetchImpl, token, args.project, HUD_COLLECTION, windowStart),
    queryReadStatsCollection(fetchImpl, token, args.project, TOTAL_COLLECTION, windowStart),
    queryReadStatsCollection(fetchImpl, token, args.project, VISITOR_COLLECTION, windowStart),
  ]);

  const snapshot = buildSnapshot({
    siteDocs,
    hudDocs,
    totalDocs,
    visitorDocs,
    windowDays: args.windowDays,
    windowStart,
    windowEnd,
    now,
  });

  logger.info?.(
    `[read-stats-snapshot] site=${siteDocs.length} hud=${hudDocs.length} total=${totalDocs.length} visitors=${visitorDocs.length} bytes≈${JSON.stringify(snapshot).length}`,
  );

  if (args.dryRun) {
    logger.info?.("[read-stats-snapshot] dry-run: skipping write");
    return snapshot;
  }

  await mkdirImpl(args.stateDir, { recursive: true });
  const outPath = path.join(args.stateDir, OUTPUT_FILENAME);
  await writer(outPath, JSON.stringify(snapshot), "utf8");
  logger.info?.(`[read-stats-snapshot] wrote ${outPath}`);
  return snapshot;
}

const isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  run().catch((err) => {
    console.error("[read-stats-snapshot] failed:", err?.message || err);
    process.exit(1);
  });
}
