import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WINDOW_MINUTES,
  buildRecentSnapshotsQuery,
  mergeSnapshots,
  parseArgs,
  run,
} from "../scripts/merge-match-snapshots.mjs";

test("parseArgs defaults", () => {
  const a = parseArgs([]);
  assert.equal(a.project, "rgleaderboard");
  assert.equal(a.windowMinutes, DEFAULT_WINDOW_MINUTES);
  assert.equal(a.dryRun, false);
});

test("parseArgs rejects a zero/negative window", () => {
  assert.throws(() => parseArgs(["--window-minutes", "0"]), /positive number/);
  assert.throws(() => parseArgs(["--window-minutes", "-3"]), /positive number/);
});

test("buildRecentSnapshotsQuery targets match_snapshots + at cursor", () => {
  const q = buildRecentSnapshotsQuery("2026-08-13T00:00:00.000Z");
  assert.equal(q.structuredQuery.from[0].collectionId, "match_snapshots");
  assert.equal(q.structuredQuery.where.fieldFilter.field.fieldPath, "at");
  assert.equal(q.structuredQuery.where.fieldFilter.op, "GREATER_THAN_OR_EQUAL");
  assert.equal(q.structuredQuery.where.fieldFilter.value.stringValue, "2026-08-13T00:00:00.000Z");
});

test("mergeSnapshots collapses one reporter into a canonical", () => {
  const canonical = mergeSnapshots("m1", [
    {
      sourceUserId: "player-a", matchId: "m1", mode: "Competitive3v3",
      outcome: "W", team: "Blue", at: "2026-08-13T04:00:00Z",
      before: { rating: 2300, displayRating: 8252, rd: 73.5, vol: 0.06 },
      after:  { rating: 2307, displayRating: 8262, rd: 73.4, vol: 0.06 },
      roster: [
        { uid: "player-a", name: "Me", team: "Blue" },
        { uid: "opp-1", name: "Opp1", team: "Orange", dr: 8100 },
      ],
    },
  ]);
  assert.equal(canonical.matchId, "m1");
  assert.equal(canonical.mode, "Competitive3v3");
  assert.deepEqual(canonical.reporters, ["player-a"]);
  const me = canonical.rosterByUid["player-a"];
  assert.equal(me.wasReporter, true);
  assert.equal(me.outcome, "W");
  assert.equal(me.before.rating, 2300);
  assert.equal(me.after.rating, 2307);
  assert.equal(canonical.rosterByUid["opp-1"].wasReporter, false);
  assert.equal(canonical.rosterByUid["opp-1"].dr, 8100);
});

test("mergeSnapshots unions rosters across multiple reporters", () => {
  const canonical = mergeSnapshots("m1", [
    {
      sourceUserId: "a", matchId: "m1", mode: "Competitive3v3",
      outcome: "W", team: "Blue", at: "2026-08-13T04:00:00Z",
      before: { rating: 2300 }, after: { rating: 2310 },
      roster: [
        { uid: "a", name: "A", team: "Blue" },
        { uid: "b", name: "B", team: "Blue" },
        { uid: "c", name: "C", team: "Orange" },
      ],
    },
    {
      sourceUserId: "c", matchId: "m1", mode: "Competitive3v3",
      outcome: "L", team: "Orange", at: "2026-08-13T04:00:05Z",
      before: { rating: 2200 }, after: { rating: 2190 },
      roster: [
        { uid: "a", name: "A", team: "Blue" },
        { uid: "c", name: "C", team: "Orange" },
        { uid: "d", name: "D", team: "Orange" }, // c saw a player a didn't
      ],
    },
  ]);
  assert.deepEqual(canonical.reporters.sort(), ["a", "c"]);
  // Both a and c should be marked reporters with their own before/after.
  assert.equal(canonical.rosterByUid["a"].wasReporter, true);
  assert.equal(canonical.rosterByUid["a"].after.rating, 2310);
  assert.equal(canonical.rosterByUid["c"].wasReporter, true);
  assert.equal(canonical.rosterByUid["c"].after.rating, 2190);
  // Non-reporters (b, d) show up but with no glicko.
  assert.equal(canonical.rosterByUid["b"].wasReporter, false);
  assert.equal(canonical.rosterByUid["b"].after, undefined);
  assert.equal(canonical.rosterByUid["d"].wasReporter, false);
});

test("mergeSnapshots flags a mode conflict without dropping the doc", () => {
  const canonical = mergeSnapshots("m1", [
    { sourceUserId: "a", matchId: "m1", mode: "Competitive3v3", at: "1", outcome: "W", team: "Blue", roster: [] },
    { sourceUserId: "b", matchId: "m1", mode: "Competitive2v2", at: "2", outcome: "L", team: "Orange", roster: [] },
  ]);
  assert.equal(canonical.conflicts.length, 1);
  assert.equal(canonical.conflicts[0].type, "mode");
  assert.equal(canonical.mode, "Competitive3v3"); // first reporter wins
});

test("mergeSnapshots returns null on empty input", () => {
  assert.equal(mergeSnapshots("m1", []), null);
});

test("run: groups snapshots by matchId and PATCHes canonical per group", async () => {
  const now = new Date("2026-08-13T04:30:00Z");
  const calls = [];
  const runQueryRows = [
    docRow("player-a_m1", {
      sourceUserId: "player-a", matchId: "m1", mode: "Competitive3v3",
      outcome: "W", team: "Blue", at: "2026-08-13T04:00:00Z",
      before: { rating: 2300 }, after: { rating: 2310 },
      roster: [{ uid: "player-a", team: "Blue" }, { uid: "opp", team: "Orange" }],
    }),
    docRow("player-b_m2", {
      sourceUserId: "player-b", matchId: "m2", mode: "Competitive2v2",
      outcome: "L", team: "Blue", at: "2026-08-13T04:10:00Z",
      before: { rating: 2000 }, after: { rating: 1990 },
      roster: [{ uid: "player-b", team: "Blue" }],
    }),
  ];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || "GET" });
    if (String(url).includes(":runQuery")) {
      return ok(JSON.stringify(runQueryRows));
    }
    if (opts?.method === "PATCH" && String(url).includes("/match_canonical/")) {
      return ok("{}");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const result = await run({
    argv: ["--project", "demo"],
    fetchImpl,
    getToken: async () => "token",
    now,
    logger: { info: () => {} },
  });
  assert.equal(result.snapshots, 2);
  assert.equal(result.canonical, 2);
  const patches = calls.filter(c => c.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.ok(patches.some(c => c.url.includes("/match_canonical/m1")));
  assert.ok(patches.some(c => c.url.includes("/match_canonical/m2")));
});

test("run: --dry-run skips PATCH writes", async () => {
  const now = new Date("2026-08-13T04:30:00Z");
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || "GET" });
    if (String(url).includes(":runQuery")) {
      return ok(JSON.stringify([
        docRow("player-a_m1", {
          sourceUserId: "player-a", matchId: "m1", mode: "Competitive3v3",
          outcome: "W", team: "Blue", at: "2026-08-13T04:00:00Z",
          before: {}, after: {}, roster: [],
        }),
      ]));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const result = await run({
    argv: ["--project", "demo", "--dry-run"],
    fetchImpl,
    getToken: async () => "token",
    now,
    logger: { info: () => {} },
  });
  assert.equal(result.snapshots, 1);
  assert.equal(result.canonical, 1);
  assert.equal(calls.filter(c => c.method === "PATCH").length, 0);
});

// ---- helpers ----

function ok(text) {
  return { ok: true, status: 200, async text() { return text; } };
}

function docRow(docId, fields) {
  return {
    document: {
      name: `projects/demo/databases/(default)/documents/match_snapshots/${docId}`,
      fields: encodeFields(fields),
    },
  };
}

function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = encode(v);
  return out;
}
function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  return { nullValue: null };
}
