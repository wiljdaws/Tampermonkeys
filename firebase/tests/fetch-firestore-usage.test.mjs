import assert from "node:assert/strict";
import test from "node:test";

import {
  bucketTimeSeries,
  docMatchesTotals,
  fetchDailyTotals,
  mergeMetricBuckets,
  parseArgs,
  upsertDailyTotals,
  utcDayKey,
} from "../scripts/fetch-firestore-usage.mjs";

test("parseArgs defaults to rgleaderboard + dry-run", () => {
  assert.deepEqual(parseArgs([]), { project: "rgleaderboard", apply: false });
  assert.deepEqual(parseArgs(["--apply"]), {
    project: "rgleaderboard",
    apply: true,
  });
  assert.deepEqual(parseArgs(["--project", "other-project"]), {
    project: "other-project",
    apply: false,
  });
});

test("utcDayKey buckets on the UTC calendar day", () => {
  assert.equal(utcDayKey("2026-08-06T00:00:00Z"), "2026-08-06");
  assert.equal(utcDayKey("2026-08-06T23:59:59Z"), "2026-08-06");
  // Very-early-UTC timestamps stay in the previous day when interpreted
  // in local TZ, but the API returns Z-suffixed strings so day math is
  // strictly UTC.
  assert.equal(utcDayKey("2026-08-07T00:00:01Z"), "2026-08-07");
});

test("bucketTimeSeries sums per-day totals from a Monitoring response", () => {
  // Shape mirrors what the real API returns for
  //   .../timeSeries?aggregation.alignmentPeriod=86400s
  //   &aggregation.perSeriesAligner=ALIGN_SUM
  //   &aggregation.crossSeriesReducer=REDUCE_SUM
  const response = {
    timeSeries: [
      {
        metric: { type: "firestore.googleapis.com/document/read_count" },
        points: [
          {
            interval: {
              startTime: "2026-08-05T00:00:00Z",
              endTime: "2026-08-06T00:00:00Z",
            },
            value: { int64Value: "12345" },
          },
          {
            interval: {
              startTime: "2026-08-06T00:00:00Z",
              endTime: "2026-08-07T00:00:00Z",
            },
            value: { int64Value: "67890" },
          },
        ],
      },
    ],
  };
  assert.deepEqual(bucketTimeSeries(response), {
    "2026-08-06": 12345,
    "2026-08-07": 67890,
  });
});

test("bucketTimeSeries adds points that land on the same UTC day", () => {
  // Defensive: if alignment ever produced two same-day points (e.g. a
  // late backfill) we still want a single per-day total.
  const response = {
    timeSeries: [
      {
        points: [
          {
            interval: { endTime: "2026-08-06T12:00:00Z" },
            value: { int64Value: "100" },
          },
          {
            interval: { endTime: "2026-08-06T18:00:00Z" },
            value: { doubleValue: 250.4 },
          },
        ],
      },
    ],
  };
  const bucket = bucketTimeSeries(response);
  assert.ok(Math.abs(bucket["2026-08-06"] - 350.4) < 1e-9);
});

test("bucketTimeSeries returns an empty object for empty responses", () => {
  assert.deepEqual(bucketTimeSeries({}), {});
  assert.deepEqual(bucketTimeSeries({ timeSeries: [] }), {});
  assert.deepEqual(bucketTimeSeries({ timeSeries: [{ points: [] }] }), {});
});

test("mergeMetricBuckets unions days across the three metrics", () => {
  const merged = mergeMetricBuckets({
    reads: { "2026-08-06": 100, "2026-08-07": 200 },
    writes: { "2026-08-07": 50 },
    deletes: {},
  });
  assert.deepEqual(merged, {
    "2026-08-06": { reads: 100, writes: 0, deletes: 0 },
    "2026-08-07": { reads: 200, writes: 50, deletes: 0 },
  });
});

test("fetchDailyTotals wires three Monitoring calls into per-day totals", async () => {
  const captured = [];
  const fakeFetch = async (url) => {
    const u = url instanceof URL ? url : new URL(url);
    captured.push(u.searchParams.get("filter"));
    const filter = u.searchParams.get("filter") ?? "";
    let value = "0";
    if (filter.includes("read_count")) value = "1000";
    else if (filter.includes("write_count")) value = "200";
    else if (filter.includes("delete_count")) value = "5";
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          timeSeries: [
            {
              points: [
                {
                  interval: { endTime: "2026-08-06T00:00:00Z" },
                  value: { int64Value: value },
                },
              ],
            },
          ],
        }),
    };
  };
  const { perDay, window } = await fetchDailyTotals({
    fetchImpl: fakeFetch,
    token: "test-token",
    project: "rgleaderboard",
    window: {
      startTime: "2026-08-04T00:00:00.000Z",
      endTime: "2026-08-06T00:00:00.000Z",
    },
  });
  assert.equal(captured.length, 3);
  assert.ok(captured.some((f) => f.includes("read_count")));
  assert.ok(captured.some((f) => f.includes("write_count")));
  assert.ok(captured.some((f) => f.includes("delete_count")));
  assert.deepEqual(perDay, {
    "2026-08-06": { reads: 1000, writes: 200, deletes: 5 },
  });
  assert.equal(window.endTime, "2026-08-06T00:00:00.000Z");
});

test("docMatchesTotals returns true only when every counter matches", () => {
  const existing = {
    fields: {
      reads: { integerValue: "100" },
      writes: { integerValue: "50" },
      deletes: { integerValue: "0" },
    },
  };
  assert.equal(
    docMatchesTotals(existing, { reads: 100, writes: 50, deletes: 0 }),
    true,
  );
  assert.equal(
    docMatchesTotals(existing, { reads: 101, writes: 50, deletes: 0 }),
    false,
  );
  assert.equal(docMatchesTotals(null, { reads: 0, writes: 0, deletes: 0 }), false);
});

test("upsertDailyTotals skips unchanged days and writes changed ones when --apply", async () => {
  const perDay = {
    "2026-08-06": { reads: 100, writes: 10, deletes: 1 },
    "2026-08-07": { reads: 200, writes: 20, deletes: 2 },
  };
  const seen = { gets: [], patches: [] };
  const fakeFetch = async (url, options) => {
    const u = url instanceof URL ? url : new URL(url);
    const method = options?.method || "GET";
    if (method === "GET") {
      seen.gets.push(u.pathname);
      // Match yesterday's doc so we exercise the skip path.
      if (u.pathname.endsWith("/2026-08-06")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              fields: {
                reads: { integerValue: "100" },
                writes: { integerValue: "10" },
                deletes: { integerValue: "1" },
              },
            }),
        };
      }
      return { ok: true, status: 404, text: async () => "" };
    }
    if (method === "PATCH") {
      seen.patches.push({
        path: u.pathname,
        body: JSON.parse(options.body),
      });
      return { ok: true, status: 200, text: async () => "{}" };
    }
    throw new Error(`unexpected method ${method}`);
  };
  const results = await upsertDailyTotals({
    fetchImpl: fakeFetch,
    token: "t",
    project: "rgleaderboard",
    perDay,
    apply: true,
    now: new Date("2026-08-07T12:00:00Z"),
  });
  assert.deepEqual(
    results.map((r) => ({ day: r.day, action: r.action })),
    [
      { day: "2026-08-06", action: "skip" },
      { day: "2026-08-07", action: "write" },
    ],
  );
  assert.equal(seen.patches.length, 1);
  assert.ok(seen.patches[0].path.endsWith("/2026-08-07"));
  assert.equal(seen.patches[0].body.fields.reads.integerValue, "200");
  assert.equal(
    seen.patches[0].body.fields.source.stringValue,
    "cloud-monitoring",
  );
});

test("upsertDailyTotals plan-writes without patching when --apply is off", async () => {
  const seen = { patches: 0 };
  const fakeFetch = async (url, options) => {
    if ((options?.method || "GET") === "PATCH") {
      seen.patches += 1;
      return { ok: true, status: 200, text: async () => "{}" };
    }
    return { ok: true, status: 404, text: async () => "" };
  };
  const results = await upsertDailyTotals({
    fetchImpl: fakeFetch,
    token: "t",
    project: "rgleaderboard",
    perDay: { "2026-08-07": { reads: 1, writes: 1, deletes: 1 } },
    apply: false,
  });
  assert.equal(seen.patches, 0);
  assert.equal(results[0].action, "plan-write");
});
