#!/usr/bin/env node
// Capture daily Firestore read/write/delete totals for the project by
// querying the GCP Monitoring API v3 and writing per-day summaries to
// admin/read-stats-total/{yyyy-mm-dd}. Runs from the same 3h aggregate
// workflow that builds the leaderboard cache — see
// .github/workflows/firestore-aggregates.yml.
//
// Usage:
//   node scripts/fetch-firestore-usage.mjs [--project rgleaderboard] [--apply]
//
// Auth: same pattern as build-leaderboard-cache — GOOGLE_OAUTH_ACCESS_TOKEN
// from workload identity in CI, or `gcloud auth print-access-token` locally.
// The service account needs roles/monitoring.viewer on the project (see
// scripts/README-monitoring.md).
//
// Behaviour:
//   - Fetches an ~48h window so we always re-fetch yesterday's day in
//     addition to today's. Cloud Monitoring lags real writes by ~3–15
//     minutes, so today's total isn't final until the following day.
//   - Idempotent — the merged setDoc leaves the doc untouched when the
//     numbers haven't changed (readback + shallow diff).
//   - Dry-run by default. Pass --apply to actually write.

import { getGcloudAccessToken } from "./build-leaderboard-cache.mjs";

// Top-level collection following the same admin_read_stats naming
// convention (underscore-separated, one doc per day). Doc IDs are the
// UTC date, e.g. read_stats_total/2026-08-06.
export const READ_STATS_COLLECTION = "read_stats_total";
export const METRICS = Object.freeze({
  reads: "firestore.googleapis.com/document/read_count",
  writes: "firestore.googleapis.com/document/write_count",
  deletes: "firestore.googleapis.com/document/delete_count",
});
// The Monitoring API is usually within ~10min of real time. We publish
// this in the doc so downstream dashboards can gray-out today's cell.
export const METRIC_LAG_MINUTES = 15;
// 48h window means every run re-computes yesterday and today. Extending
// the window costs one extra data point per metric — negligible.
export const WINDOW_HOURS = 48;

export function parseArgs(argv) {
  const args = { project: "rgleaderboard", apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--apply") args.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "fetch-firestore-usage.mjs [--project rgleaderboard] [--apply]",
      );
      process.exit(0);
    }
  }
  return args;
}

// Convert an ISO timestamp to the calendar day it belongs to in UTC.
// GCP Monitoring returns per-point intervals; we bucket each point's
// endTime into a `YYYY-MM-DD` bucket.
export function utcDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Unparseable timestamp from Monitoring API: ${iso}`);
  }
  return d.toISOString().slice(0, 10);
}

function pointValue(point) {
  const v = point?.value ?? {};
  if (v.int64Value !== undefined) return Number(v.int64Value);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  return 0;
}

// Given the Monitoring API `timeSeries` response for a single metric,
// return `{ 'YYYY-MM-DD': totalPointsSum }`. With alignmentPeriod=86400s
// each returned point is already a per-day sum, but we defensively
// re-sum in case the alignment window crosses a day boundary and the
// API returns two points for a day.
export function bucketTimeSeries(response) {
  const buckets = {};
  const series = response?.timeSeries ?? [];
  for (const s of series) {
    const points = s?.points ?? [];
    for (const p of points) {
      const endTime = p?.interval?.endTime;
      if (!endTime) continue;
      const day = utcDayKey(endTime);
      buckets[day] = (buckets[day] ?? 0) + pointValue(p);
    }
  }
  return buckets;
}

// Merges three per-metric bucket maps into a canonical per-day shape.
export function mergeMetricBuckets({ reads, writes, deletes }) {
  const days = new Set([
    ...Object.keys(reads),
    ...Object.keys(writes),
    ...Object.keys(deletes),
  ]);
  const out = {};
  for (const day of days) {
    out[day] = {
      reads: Math.round(reads[day] ?? 0),
      writes: Math.round(writes[day] ?? 0),
      deletes: Math.round(deletes[day] ?? 0),
    };
  }
  return out;
}

function monitoringWindow(now = new Date()) {
  const end = now;
  const start = new Date(end.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

async function fetchOneMetric({
  fetchImpl,
  token,
  project,
  metric,
  startTime,
  endTime,
}) {
  const url = new URL(
    `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries`,
  );
  url.searchParams.set(
    "filter",
    `metric.type="${metric}" AND resource.type="firestore_instance"`,
  );
  url.searchParams.set("interval.startTime", startTime);
  url.searchParams.set("interval.endTime", endTime);
  url.searchParams.set("aggregation.alignmentPeriod", "86400s");
  url.searchParams.set("aggregation.perSeriesAligner", "ALIGN_SUM");
  url.searchParams.set("aggregation.crossSeriesReducer", "REDUCE_SUM");

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    redirect: "error",
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(
      `Monitoring API failed for ${metric} (${response.status}): ${message}`,
    );
  }
  return body;
}

// Convenience: fetch all three metrics in parallel and return the
// merged per-day totals plus the raw window used.
export async function fetchDailyTotals({
  fetchImpl = globalThis.fetch,
  token,
  project,
  window = monitoringWindow(),
}) {
  const [readsResp, writesResp, deletesResp] = await Promise.all([
    fetchOneMetric({
      fetchImpl,
      token,
      project,
      metric: METRICS.reads,
      ...window,
    }),
    fetchOneMetric({
      fetchImpl,
      token,
      project,
      metric: METRICS.writes,
      ...window,
    }),
    fetchOneMetric({
      fetchImpl,
      token,
      project,
      metric: METRICS.deletes,
      ...window,
    }),
  ]);
  const perDay = mergeMetricBuckets({
    reads: bucketTimeSeries(readsResp),
    writes: bucketTimeSeries(writesResp),
    deletes: bucketTimeSeries(deletesResp),
  });
  return { perDay, window };
}

function docPath(project, docId) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents/${READ_STATS_COLLECTION}/${encodeURIComponent(docId)}`;
}

function docFieldsFor({ date, reads, writes, deletes, fetchedAt }) {
  return {
    date: { stringValue: date },
    reads: { integerValue: String(reads) },
    writes: { integerValue: String(writes) },
    deletes: { integerValue: String(deletes) },
    source: { stringValue: "cloud-monitoring" },
    fetchedAt: { stringValue: fetchedAt },
    metricLagMinutes: { integerValue: String(METRIC_LAG_MINUTES) },
  };
}

function readInt(field) {
  if (!field) return null;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.doubleValue !== undefined) return Number(field.doubleValue);
  return null;
}

// True if the existing doc already carries the same counts. `fetchedAt`
// changes every run, so we don't compare it — only the numbers.
export function docMatchesTotals(existing, totals) {
  if (!existing?.fields) return false;
  return (
    readInt(existing.fields.reads) === totals.reads
    && readInt(existing.fields.writes) === totals.writes
    && readInt(existing.fields.deletes) === totals.deletes
  );
}

async function firestoreGet({ fetchImpl, token, project, docId }) {
  const response = await fetchImpl(docPath(project, docId), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    redirect: "error",
  });
  if (response.status === 404) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(
      `Firestore GET failed for ${docId} (${response.status}): ${message}`,
    );
  }
  return body;
}

async function firestorePatch({
  fetchImpl,
  token,
  project,
  docId,
  totals,
  fetchedAt,
}) {
  // updateMask covers every field so a stale document that's missing
  // one of them still gets fully rewritten to the canonical shape.
  const url = new URL(docPath(project, docId));
  for (const field of [
    "date",
    "reads",
    "writes",
    "deletes",
    "source",
    "fetchedAt",
    "metricLagMinutes",
  ]) {
    url.searchParams.append("updateMask.fieldPaths", field);
  }
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: docFieldsFor({ date: docId, ...totals, fetchedAt }),
    }),
    redirect: "error",
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(
      `Firestore PATCH failed for ${docId} (${response.status}): ${message}`,
    );
  }
  return body;
}

export async function upsertDailyTotals({
  fetchImpl = globalThis.fetch,
  token,
  project,
  perDay,
  apply,
  now = new Date(),
}) {
  const fetchedAt = now.toISOString();
  const days = Object.keys(perDay).sort();
  const results = [];
  for (const day of days) {
    const totals = perDay[day];
    const existing = await firestoreGet({
      fetchImpl,
      token,
      project,
      docId: day,
    });
    if (docMatchesTotals(existing, totals)) {
      results.push({ day, action: "skip", totals });
      continue;
    }
    if (!apply) {
      results.push({ day, action: "plan-write", totals });
      continue;
    }
    await firestorePatch({
      fetchImpl,
      token,
      project,
      docId: day,
      totals,
      fetchedAt,
    });
    results.push({ day, action: "write", totals });
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await getGcloudAccessToken();
  const { perDay, window } = await fetchDailyTotals({
    token,
    project: args.project,
  });
  const days = Object.keys(perDay).sort();
  console.log(
    `[fetch-firestore-usage] project=${args.project} window=${window.startTime}..${window.endTime} days=${days.length}`,
  );
  for (const day of days) {
    const t = perDay[day];
    console.log(
      `  ${day} reads=${t.reads} writes=${t.writes} deletes=${t.deletes}`,
    );
  }
  const results = await upsertDailyTotals({
    token,
    project: args.project,
    perDay,
    apply: args.apply,
  });
  for (const r of results) {
    console.log(
      `[fetch-firestore-usage] ${r.action} ${r.day} reads=${r.totals.reads} writes=${r.totals.writes} deletes=${r.totals.deletes}`,
    );
  }
  if (!args.apply) {
    console.log("[fetch-firestore-usage] dry-run: pass --apply to write");
  }
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error("[fetch-firestore-usage] failed:", err?.message || err);
    process.exit(1);
  });
}
