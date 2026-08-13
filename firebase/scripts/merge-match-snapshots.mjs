#!/usr/bin/env node
// Groups match_snapshots by matchId into a canonical match_canonical/{matchId}
// doc. Each HUD in a match writes its own snapshot; this merges every
// reporter's before/after glicko onto one roster entry per uid, so downstream
// analysis has one row per match instead of N.
//
// Runs on a cron (see .github/workflows/merge-match-snapshots.yml). Scans
// snapshots created in the last (windowMinutes + buffer) minutes so late
// arrivals from slow clients still land in the right canonical doc.
//
// Usage:
//   node scripts/merge-match-snapshots.mjs --project rgleaderboard
//     [--window-minutes 20] [--dry-run]

import { getGcloudAccessToken } from "./build-leaderboard-cache.mjs";
import { fileURLToPath } from "node:url";

export const DEFAULT_WINDOW_MINUTES = 20;
export const SNAPSHOTS_COLLECTION = "match_snapshots";
export const CANONICAL_COLLECTION = "match_canonical";

export function parseArgs(argv) {
  const args = {
    project: "rgleaderboard",
    windowMinutes: DEFAULT_WINDOW_MINUTES,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--window-minutes") args.windowMinutes = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "merge-match-snapshots.mjs --project <id> [--window-minutes 20] [--dry-run]",
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.windowMinutes) || args.windowMinutes < 1) {
    throw new Error("--window-minutes must be a positive number");
  }
  return args;
}

function documentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
}

async function firestore(fetchImpl, method, url, token, project, body) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Goog-User-Project": project,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Firestore JSON decode helpers — mirror snapshot-production.mjs's approach.
const V = (v) => {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeMap(v.mapValue);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(V);
  return null;
};
function decodeMap(mapValue) {
  const out = {};
  for (const [k, val] of Object.entries(mapValue.fields || {})) out[k] = V(val);
  return out;
}

// The inverse: JS value → Firestore Value object.
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toValue(val);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

// Query snapshots whose `at` (ISO string on the doc) is newer than the
// window cutoff. Uses runQuery so we don't have to page a whole collection.
export function buildRecentSnapshotsQuery(sinceIso) {
  return {
    structuredQuery: {
      from: [{ collectionId: SNAPSHOTS_COLLECTION }],
      where: {
        fieldFilter: {
          field: { fieldPath: "at" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { stringValue: sinceIso },
        },
      },
      orderBy: [{ field: { fieldPath: "at" }, direction: "ASCENDING" }],
    },
  };
}

// Merges N snapshots (all with the same matchId) into one canonical.
// Later reporters override earlier fields only when they're the same
// player (their own before/after wins). Roster is the union by uid;
// reporter rosters that provided richer info (dr present) win.
export function mergeSnapshots(matchId, snapshots) {
  if (!snapshots.length) return null;
  // Sort by `at` so the earliest report wins for outcome/mode/team
  // (they should all agree, but if they don't the first one seen is
  // canonical and the disagreements land in `conflicts`).
  const sorted = [...snapshots].sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  const first = sorted[0];
  const canonical = {
    matchId,
    mode: first.mode || null,
    at: first.at || null,
    outcome: null, // set below from the reporter whose team matches
    reporters: [],
    rosterByUid: {},
    conflicts: [],
    mergedAt: new Date().toISOString(),
  };

  const rosterMerge = new Map(); // uid -> canonical roster entry
  for (const snap of sorted) {
    canonical.reporters.push(snap.sourceUserId);

    // Detect mode/at drift (rare — same matchId should have same mode).
    if (canonical.mode && snap.mode && snap.mode !== canonical.mode) {
      canonical.conflicts.push({ type: "mode", reporter: snap.sourceUserId, value: snap.mode });
    }

    // Union roster; a reporter's own line has the freshest team.
    for (const r of Array.isArray(snap.roster) ? snap.roster : []) {
      if (!r?.uid) continue;
      const prev = rosterMerge.get(r.uid) || {
        uid: r.uid, name: r.name || "", team: r.team || null, wasReporter: false,
      };
      // Prefer a non-empty name / non-null team when merging.
      if (r.name && !prev.name) prev.name = r.name;
      if (r.team && !prev.team) prev.team = r.team;
      // Only accept dr from the highest-info roster snapshot.
      if (typeof r.dr === "number" && typeof prev.dr !== "number") prev.dr = r.dr;
      rosterMerge.set(r.uid, prev);
    }

    // Reporter's own before/after glicko is authoritative for their uid.
    const entry = rosterMerge.get(snap.sourceUserId);
    if (entry) {
      entry.wasReporter = true;
      if (snap.before) entry.before = snap.before;
      if (snap.after) entry.after = snap.after;
      // Reporter's own team is the truth.
      if (snap.team) entry.team = snap.team;
    }
  }

  // Canonical outcome: use the outcome from any reporter (they should
  // all report the same W/L/T for their own team, and we're storing
  // per-reporter outcomes on roster entries anyway).
  for (const snap of sorted) {
    if (snap.outcome) {
      const entry = rosterMerge.get(snap.sourceUserId);
      if (entry) entry.outcome = snap.outcome;
    }
  }
  canonical.rosterByUid = Object.fromEntries(rosterMerge);
  return canonical;
}

// Walks a runQuery response and returns decoded doc objects.
function decodeRunQuery(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.document) continue;
    const path = row.document.name.split("/documents/")[1];
    const fields = row.document.fields || {};
    const decoded = { _docId: path.split("/").pop() };
    for (const [k, v] of Object.entries(fields)) decoded[k] = V(v);
    out.push(decoded);
  }
  return out;
}

export async function run({
  argv = process.argv.slice(2),
  fetchImpl = globalThis.fetch,
  getToken = getGcloudAccessToken,
  now = new Date(),
  logger = console,
} = {}) {
  const args = parseArgs(argv);
  const token = await getToken();
  const base = documentsBase(args.project);
  const sinceIso = new Date(now.getTime() - args.windowMinutes * 60_000).toISOString();

  logger.info?.(`[merge] scanning ${SNAPSHOTS_COLLECTION} since ${sinceIso}`);
  const rows = await firestore(
    fetchImpl, "POST", `${base}:runQuery`, token, args.project,
    buildRecentSnapshotsQuery(sinceIso),
  );
  const snapshots = decodeRunQuery(rows);
  logger.info?.(`[merge] fetched ${snapshots.length} snapshot(s)`);

  const groups = new Map();
  for (const snap of snapshots) {
    const id = snap.matchId;
    if (!id) continue;
    (groups.get(id) || groups.set(id, []).get(id)).push(snap);
  }

  const results = [];
  for (const [matchId, snaps] of groups) {
    const canonical = mergeSnapshots(matchId, snaps);
    if (!canonical) continue;
    results.push(canonical);
    if (args.dryRun) {
      logger.info?.(`[merge] (dry-run) would write ${CANONICAL_COLLECTION}/${matchId} (${snaps.length} reporter(s))`);
      continue;
    }
    const url = `${base}/${CANONICAL_COLLECTION}/${encodeURIComponent(matchId)}`;
    const body = { fields: {} };
    for (const [k, v] of Object.entries(canonical)) body.fields[k] = toValue(v);
    // PATCH without updateMask replaces the doc — we want that: the
    // canonical is rebuilt from scratch each run, so no field drift.
    await firestore(fetchImpl, "PATCH", url, token, args.project, body);
  }
  logger.info?.(`[merge] wrote ${args.dryRun ? 0 : results.length} canonical doc(s)`);
  return { snapshots: snapshots.length, canonical: results.length, matches: results };
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
    console.error("[merge] failed:", err?.message || err);
    process.exit(1);
  });
}
