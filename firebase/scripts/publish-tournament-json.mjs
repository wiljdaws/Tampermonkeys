#!/usr/bin/env node
// Reads tournament_leaderboard from Firestore and emits leaderboard/tournament.json
// so the public site can serve the tab from the CDN instead of hitting Firestore.
// Runs after build-leaderboard-cache in the publish workflow.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { decodeFirestoreDocument } from "./snapshot-production.mjs";

const execFileAsync = promisify(execFile);

const COLLECTION = "tournament_leaderboard";
const TOP_N = 100;
const JSON_SCHEMA_VERSION = 1;

function documentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
}

async function getGcloudAccessToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  }
  const { stdout } = await execFileAsync(
    "gcloud",
    ["auth", "print-access-token"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDSDK_METRICS_ENVIRONMENT: "atlas-tournament-json",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const token = stdout.trim();
  if (!token) throw new Error("gcloud returned an empty access token");
  return token;
}

async function apiJson(url, { method = "GET", token, project, body } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Goog-User-Project": project,
  };
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = parsed?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return parsed;
}

async function queryTournamentRows(token, project) {
  const body = await apiJson(`${documentsBase(project)}:runQuery`, {
    method: "POST",
    token,
    project,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: COLLECTION }],
        orderBy: [
          { field: { fieldPath: "score" }, direction: "DESCENDING" },
        ],
        limit: TOP_N,
      },
    }),
  });
  const rows = [];
  for (const entry of body || []) {
    if (!entry?.document) continue;
    const decoded = decodeFirestoreDocument(entry.document);
    rows.push({ ...decoded.fields, _docId: decoded.id });
  }
  return rows;
}

// Kept intentionally slim: only the fields the site actually renders for
// tournament rows. Session/streak fields don't apply to manual entries.
// No rank field: the site sorts by score DESC then name ASC and computes
// rank from array position, so emitting rank here just fights that.
function compactTournamentRow(row) {
  if (!row) return null;
  const compact = {
    id: row._docId,
    name: String(row.name || ""),
    score: Number(row.score) || 0,
    matches: Number(row.matches) || 0,
  };
  if (row.flag) compact.flag = row.flag;
  if (row.icons) compact.icons = row.icons;
  if (row.iconSize != null) compact.iconSize = row.iconSize;
  if (row.glowColor) compact.glowColor = row.glowColor;
  if (row.glowStrength != null) compact.glowStrength = row.glowStrength;
  return compact;
}

function buildTournamentJson(rows) {
  const enriched = rows
    .map(compactTournamentRow)
    .filter(Boolean)
    // Deterministic tiebreak: score DESC then name ASC. Same order the
    // site uses so consumers that DO read rank see stable values.
    .sort((a, b) =>
      b.score - a.score
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const compactForHash = enriched.map(row => ({
    id: row.id, name: row.name, score: row.score, matches: row.matches,
  }));
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(compactForHash))
    .digest("hex");
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    playlist: "tournament",
    builtAt: new Date().toISOString(),
    builder: "publish-tournament-json",
    sourceHash,
    rowCount: enriched.length,
    rows: enriched,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let project = "rgleaderboard";
  let outputDir = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--project" && args[i + 1]) { project = args[i + 1]; i += 1; }
    else if (args[i] === "--output-dir" && args[i + 1]) { outputDir = args[i + 1]; i += 1; }
  }
  if (!outputDir) {
    console.error("--output-dir <path> is required");
    process.exit(1);
  }

  const token = await getGcloudAccessToken();
  const rows = await queryTournamentRows(token, project);
  const doc = buildTournamentJson(rows);
  await mkdir(outputDir, { recursive: true });
  const outPath = join(outputDir, "tournament.json");
  await writeFile(outPath, JSON.stringify(doc), "utf8");
  console.log(`[publish-tournament-json] wrote ${outPath} (${doc.rowCount} rows)`);
}

main().catch(err => {
  console.error("[publish-tournament-json] failed:", err.message || err);
  process.exit(1);
});
