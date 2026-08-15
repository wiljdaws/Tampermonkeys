// One-shot cleanup script for the HUD 19.6 doc-id migration.
//
// Before HUD 19.6, `leaderboard` docs lived at `{gameplayerid}_{playlist}`.
// From 19.6 on, they live at `{firebaseAuthUid}_{playlist}` so per-player
// writes finally match the security-rule identity gate. The site briefly
// double-counted anyone who upgraded because BOTH docs are still present:
// the pre-19.6 orphan + the new anon-uid slot.
//
// Both docs carry the same `rgPlayerId` field (the in-game player id the
// HUD stamps on every write). Grouping by it lets us keep the freshest
// `lastWriteAt` — always the 19.6 doc, since the pre-19.6 doc has been
// silent for at least one HUD update cycle — and delete the stragglers.
//
// Rows without an `rgPlayerId` are legit manual admin entries (site quick
// adds have random Firestore ids and no rgPlayerId). Those never get
// touched.
//
// Dry-run is default. `--apply` is required to actually delete anything.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  decodeFirestoreDocument,
} from "./snapshot-production.mjs";

const execFileAsync = promisify(execFile);

const BLOCKED_ARGUMENTS = new Set([
  "--commit",
  "--create",
  "--deploy",
  "--force",
  "--import",
  "--mutation",
  "--production",
  "--restore",
  "--set",
  "--update",
  "--write",
]);

export const PLAYLISTS = Object.freeze(["1v1", "2v2", "3v3", "wins"]);

export const HELP = `Dedupe legacy pre-19.6 leaderboard docs.

Dry run (default — no writes, prints the delete plan):
  node scripts/dedupe-leaderboard.mjs --project rgleaderboard --dry-run

Apply the plan (deletes older duplicates per rgPlayerId group):
  node scripts/dedupe-leaderboard.mjs --project rgleaderboard --apply

Optional:
  --playlists 1v1,2v2,3v3,wins   (default: all four)
  --batch 100                    (delete-commit batch size, default 100)

Safety:
  - Rows missing rgPlayerId are treated as manual admin entries and skipped.
  - Only groups with more than one row are considered.
  - Within each group, the row with the newest lastWriteAt is kept.
  - --apply is required for real writes; without it, nothing is deleted.
  - Mutation-shaped flags (--commit/--set/etc.) are rejected outright so
    a typo can't sneak past the --apply gate.
`;

function argumentKey(argument) {
  return argument.includes("=")
    ? argument.slice(0, argument.indexOf("="))
    : argument;
}

export function parseDedupeArguments(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  for (const argument of args) {
    const key = argumentKey(argument);
    if (BLOCKED_ARGUMENTS.has(key)) {
      throw new Error(`${key} is blocked: use --apply for cache writes`);
    }
  }

  let project = "";
  let apply = false;
  let dryRun = false;
  let playlists = null;
  let batchSize = 100;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") { apply = true; continue; }
    if (argument === "--dry-run") { dryRun = true; continue; }
    if (argument === "--project") {
      if (project || !args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--project requires one explicit project ID");
      }
      project = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--project=")) {
      if (project) throw new Error("--project may only be provided once");
      project = argument.slice("--project=".length);
      continue;
    }
    if (argument === "--playlists") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--playlists requires a comma-separated list");
      }
      playlists = args[index + 1].split(",").map(v => v.trim()).filter(Boolean);
      index += 1;
      continue;
    }
    if (argument.startsWith("--playlists=")) {
      playlists = argument.slice("--playlists=".length)
        .split(",").map(v => v.trim()).filter(Boolean);
      continue;
    }
    if (argument === "--batch") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--batch requires a positive integer");
      }
      batchSize = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--batch=")) {
      batchSize = Number(argument.slice("--batch=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!project) throw new Error("--project is required");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new Error("Project ID has an invalid format");
  }
  if (apply && dryRun) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  if (playlists === null) playlists = [...PLAYLISTS];
  for (const playlist of playlists) {
    if (!PLAYLISTS.includes(playlist)) {
      throw new Error(`Unsupported playlist: ${playlist}`);
    }
  }
  if (!playlists.length) throw new Error("--playlists must not be empty");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("--batch must be an integer from 1 to 500");
  }

  return { help: false, project, apply, dryRun, playlists, batchSize };
}

export async function getGcloudAccessToken() {
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
        CLOUDSDK_METRICS_ENVIRONMENT: "atlas-dedupe-leaderboard",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const token = stdout.trim();
  if (!token) throw new Error("gcloud returned an empty access token");
  return token;
}

function documentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
}

async function apiJson(fetchImpl, token, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-Goog-User-Project": options.quotaProject || "",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    redirect: "error",
  });
  if (options.method === "GET" && response.status === 404) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return body;
}

// Full-collection scan of `leaderboard` filtered to one playlist via
// runQuery. Uses the same shape as build-leaderboard-cache.mjs but with
// no orderBy so we get every doc, not just the top-N.
async function scanPlaylist(fetchImpl, token, project, playlist) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:runQuery`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "leaderboard" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "playlist" },
              op: "EQUAL",
              value: { stringValue: playlist },
            },
          },
        },
      }),
    },
  );
  const rows = [];
  for (const entry of body || []) {
    if (!entry?.document) continue;
    const decoded = decodeFirestoreDocument(entry.document);
    rows.push({ ...decoded.fields, _docId: decoded.id });
  }
  return rows;
}

// lastWriteAt is stored as a Firestore timestamp; after decodeFirestoreDocument
// it lands as either a wrapper `{ __firestoreType: "timestamp", value }` or a
// bare ISO string when it was already a string. Normalize both.
export function lastWriteAtMs(row) {
  const raw = row?.lastWriteAt;
  if (!raw) return 0;
  const iso = typeof raw === "string" ? raw : raw?.value;
  if (typeof iso !== "string") return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// Group rows by rgPlayerId. Rows without rgPlayerId (manual admin entries)
// are skipped entirely. For each group of >1 rows, keep the newest
// lastWriteAt as the canonical row and mark the rest as deletes.
export function planDedupe(rows, playlist) {
  const groups = new Map();
  for (const row of rows) {
    const rgPlayerId = typeof row?.rgPlayerId === "string"
      ? row.rgPlayerId.trim()
      : "";
    if (!rgPlayerId) continue;
    if (!groups.has(rgPlayerId)) groups.set(rgPlayerId, []);
    groups.get(rgPlayerId).push(row);
  }

  const plan = [];
  for (const [rgPlayerId, groupRows] of groups) {
    if (groupRows.length < 2) continue;
    // Newest lastWriteAt wins. Tie-breaker: prefer the row whose docId
    // starts with the rgPlayerId (definitely pre-19.6) losing to the one
    // that doesn't (the 19.6 anon-uid keyed row). Falls back to docId
    // string compare for full determinism.
    const sorted = [...groupRows].sort((a, b) => {
      const aTs = lastWriteAtMs(a);
      const bTs = lastWriteAtMs(b);
      if (aTs !== bTs) return bTs - aTs;
      const aLegacy = String(a._docId || "").startsWith(`${rgPlayerId}_`);
      const bLegacy = String(b._docId || "").startsWith(`${rgPlayerId}_`);
      if (aLegacy !== bLegacy) return aLegacy ? 1 : -1;
      return String(a._docId).localeCompare(String(b._docId));
    });
    const [keep, ...rest] = sorted;
    plan.push({
      rgPlayerId,
      playlist,
      keep: rowSummary(keep, "keep"),
      deletes: rest.map(row => rowSummary(row, "delete")),
    });
  }
  return plan;
}

function rowSummary(row, action) {
  return {
    action,
    docId: String(row._docId || ""),
    name: String(row.name || ""),
    mmr: Number.isFinite(Number(row.mmr)) ? Number(row.mmr) : null,
    lastWriteAt: typeof row.lastWriteAt === "string"
      ? row.lastWriteAt
      : row.lastWriteAt?.value || null,
  };
}

async function commitDeletes(fetchImpl, token, project, docIds, batchSize) {
  let deleted = 0;
  for (let i = 0; i < docIds.length; i += batchSize) {
    const chunk = docIds.slice(i, i + batchSize);
    const writes = chunk.map(docId => ({
      delete: `projects/${project}/databases/(default)/documents/leaderboard/${docId}`,
    }));
    await apiJson(fetchImpl, token, `${documentsBase(project)}:commit`, {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({ writes }),
    });
    deleted += chunk.length;
  }
  return deleted;
}

export async function dedupeLeaderboard({
  project,
  apply = false,
  playlists = PLAYLISTS,
  batchSize = 100,
  fetchImpl = globalThis.fetch,
  getToken = getGcloudAccessToken,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  const token = await getToken();

  const allPlans = [];
  let totalDeletes = 0;
  for (const playlist of playlists) {
    const rows = await scanPlaylist(fetchImpl, token, project, playlist);
    const plans = planDedupe(rows, playlist);
    logger.log(
      `SCAN ${playlist} rows=${rows.length} groups=${plans.length} `
        + `deletes=${plans.reduce((n, p) => n + p.deletes.length, 0)}`,
    );
    for (const entry of plans) {
      logger.log(
        `  keep    ${entry.keep.docId} name="${entry.keep.name}" `
          + `mmr=${entry.keep.mmr ?? "-"} lastWriteAt=${entry.keep.lastWriteAt}`,
      );
      for (const del of entry.deletes) {
        logger.log(
          `  delete  ${del.docId} name="${del.name}" `
            + `mmr=${del.mmr ?? "-"} lastWriteAt=${del.lastWriteAt}`,
        );
        totalDeletes += 1;
      }
    }
    allPlans.push({ playlist, plans });
  }

  let applied = 0;
  if (apply && totalDeletes > 0) {
    const docIds = [];
    for (const { plans } of allPlans) {
      for (const entry of plans) {
        for (const del of entry.deletes) docIds.push(del.docId);
      }
    }
    applied = await commitDeletes(fetchImpl, token, project, docIds, batchSize);
    logger.log(`APPLIED ${applied} deletes across ${playlists.length} playlist(s).`);
  } else if (apply) {
    logger.log("APPLIED 0 deletes (nothing to remove).");
  } else {
    logger.log(
      `Dry run: ${totalDeletes} delete(s) planned across ${playlists.length} `
        + `playlist(s). Re-run with --apply to execute.`,
    );
  }
  return { project, apply, playlists, plans: allPlans, totalDeletes, applied };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseDedupeArguments(argv);
  if (parsed.help) {
    console.log(HELP);
    return { help: true };
  }
  return dedupeLeaderboard({
    project: parsed.project,
    apply: parsed.apply,
    playlists: parsed.playlists,
    batchSize: parsed.batchSize,
    ...options,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
