import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupeLeaderboard,
  lastWriteAtMs,
  parseDedupeArguments,
  planDedupe,
} from "../scripts/dedupe-leaderboard.mjs";

// --- Argument parsing --------------------------------------------------------

test("parseDedupeArguments requires --project", () => {
  assert.throws(() => parseDedupeArguments(["--dry-run"]), /--project/);
});

test("parseDedupeArguments rejects mutation-shaped flags", () => {
  assert.throws(
    () => parseDedupeArguments(["--project", "rgleaderboard", "--write"]),
    /--write is blocked/,
  );
});

test("parseDedupeArguments accepts --dry-run", () => {
  const parsed = parseDedupeArguments(["--project", "rgleaderboard", "--dry-run"]);
  assert.equal(parsed.help, false);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.apply, false);
  assert.deepEqual(parsed.playlists, ["1v1", "2v2", "3v3", "wins"]);
});

test("parseDedupeArguments does not accept --dry-run + --apply together", () => {
  assert.throws(
    () => parseDedupeArguments(["--project", "rgleaderboard", "--dry-run", "--apply"]),
    /mutually exclusive/,
  );
});

// --- planDedupe --------------------------------------------------------------

test("planDedupe queues the older row for delete and keeps the newer one", () => {
  const rows = [
    {
      _docId: "gp-42_1v1",
      playlist: "1v1",
      name: "TestPlayer",
      mmr: 1200,
      rgPlayerId: "gp-42",
      lastWriteAt: "2026-07-15T12:00:00.000Z",
    },
    {
      _docId: "authUidABC_1v1",
      playlist: "1v1",
      name: "TestPlayer",
      mmr: 1234,
      rgPlayerId: "gp-42",
      lastWriteAt: "2026-08-10T09:15:00.000Z",
    },
  ];
  const plan = planDedupe(rows, "1v1");
  assert.equal(plan.length, 1);
  assert.equal(plan[0].rgPlayerId, "gp-42");
  assert.equal(plan[0].keep.docId, "authUidABC_1v1");
  assert.equal(plan[0].keep.action, "keep");
  assert.equal(plan[0].deletes.length, 1);
  assert.equal(plan[0].deletes[0].docId, "gp-42_1v1");
  assert.equal(plan[0].deletes[0].action, "delete");
});

test("planDedupe skips rows without an rgPlayerId (manual admin entries)", () => {
  const rows = [
    { _docId: "manual1", playlist: "1v1", name: "AdminEntry", mmr: 500 },
    { _docId: "manual2", playlist: "1v1", name: "OtherAdmin", mmr: 400 },
    {
      _docId: "authUid_1v1",
      playlist: "1v1",
      name: "AdminEntry",
      mmr: 500,
      rgPlayerId: "",
      lastWriteAt: "2026-08-10T09:15:00.000Z",
    },
  ];
  const plan = planDedupe(rows, "1v1");
  assert.equal(plan.length, 0);
});

test("planDedupe leaves single-row groups alone", () => {
  const rows = [
    {
      _docId: "authUid_1v1",
      playlist: "1v1",
      name: "Solo",
      mmr: 900,
      rgPlayerId: "gp-lonely",
      lastWriteAt: "2026-08-10T09:15:00.000Z",
    },
  ];
  assert.deepEqual(planDedupe(rows, "1v1"), []);
});

test("planDedupe handles three-way duplicates by keeping only the newest", () => {
  const rows = [
    {
      _docId: "old-a", playlist: "1v1", name: "P", mmr: 1000, rgPlayerId: "gp-9",
      lastWriteAt: "2026-01-01T00:00:00.000Z",
    },
    {
      _docId: "old-b", playlist: "1v1", name: "P", mmr: 1100, rgPlayerId: "gp-9",
      lastWriteAt: "2026-03-01T00:00:00.000Z",
    },
    {
      _docId: "new", playlist: "1v1", name: "P", mmr: 1300, rgPlayerId: "gp-9",
      lastWriteAt: "2026-08-01T00:00:00.000Z",
    },
  ];
  const plan = planDedupe(rows, "1v1");
  assert.equal(plan.length, 1);
  assert.equal(plan[0].keep.docId, "new");
  assert.deepEqual(
    plan[0].deletes.map(d => d.docId).sort(),
    ["old-a", "old-b"],
  );
});

test("planDedupe accepts wrapped timestamp shape from decodeFirestoreDocument", () => {
  const rows = [
    {
      _docId: "legacy",
      playlist: "1v1",
      name: "P",
      mmr: 1000,
      rgPlayerId: "gp-1",
      lastWriteAt: { __firestoreType: "timestamp", value: "2026-01-01T00:00:00.000Z" },
    },
    {
      _docId: "newer",
      playlist: "1v1",
      name: "P",
      mmr: 1200,
      rgPlayerId: "gp-1",
      lastWriteAt: { __firestoreType: "timestamp", value: "2026-08-01T00:00:00.000Z" },
    },
  ];
  const plan = planDedupe(rows, "1v1");
  assert.equal(plan[0].keep.docId, "newer");
  assert.equal(plan[0].deletes[0].docId, "legacy");
});

test("planDedupe prefers non-legacy docId when timestamps tie", () => {
  const rows = [
    {
      _docId: "gp-5_1v1", playlist: "1v1", name: "P", mmr: 1000, rgPlayerId: "gp-5",
      lastWriteAt: "2026-08-01T00:00:00.000Z",
    },
    {
      _docId: "authUidXYZ_1v1", playlist: "1v1", name: "P", mmr: 1000, rgPlayerId: "gp-5",
      lastWriteAt: "2026-08-01T00:00:00.000Z",
    },
  ];
  const plan = planDedupe(rows, "1v1");
  assert.equal(plan[0].keep.docId, "authUidXYZ_1v1");
  assert.equal(plan[0].deletes[0].docId, "gp-5_1v1");
});

test("lastWriteAtMs normalizes both string and wrapped timestamps", () => {
  assert.equal(lastWriteAtMs({ lastWriteAt: "2026-08-01T00:00:00.000Z" }),
    Date.parse("2026-08-01T00:00:00.000Z"));
  assert.equal(lastWriteAtMs({
    lastWriteAt: { __firestoreType: "timestamp", value: "2026-08-01T00:00:00.000Z" },
  }), Date.parse("2026-08-01T00:00:00.000Z"));
  assert.equal(lastWriteAtMs({}), 0);
  assert.equal(lastWriteAtMs(null), 0);
});

// --- dedupeLeaderboard (mocked fetch) ---------------------------------------

// Builds a mocked Firestore fetch. Serves runQuery reads against a fixture
// dataset, records any :commit deletes, and never touches the real network.
function createMockFetch(rowsByPlaylist) {
  const commits = [];
  const fetchImpl = async (url, options) => {
    const target = String(url);
    if (target.endsWith(":runQuery")) {
      const body = JSON.parse(options.body);
      const filter = body.structuredQuery.where.fieldFilter;
      const playlist = filter.value.stringValue;
      const rows = rowsByPlaylist[playlist] || [];
      const documents = rows.map(row => ({
        document: {
          name: `projects/mock/databases/(default)/documents/leaderboard/${row._docId}`,
          fields: encodeFields(row),
          createTime: "2026-08-01T00:00:00.000Z",
          updateTime: "2026-08-01T00:00:00.000Z",
        },
      }));
      return jsonResponse(200, documents);
    }
    if (target.endsWith(":commit")) {
      const body = JSON.parse(options.body);
      commits.push(body);
      return jsonResponse(200, {
        writeResults: body.writes.map(() => ({})),
      });
    }
    throw new Error(`Unexpected fetch to ${target}`);
  };
  return { fetchImpl, commits };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

// Minimal encoder that covers what planDedupe needs. Handles strings,
// numbers, and the wrapped timestamp shape.
function encodeFields(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "_docId") continue;
    if (value == null) { out[key] = { nullValue: null }; continue; }
    if (typeof value === "string") { out[key] = { stringValue: value }; continue; }
    if (typeof value === "number") {
      out[key] = Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value };
      continue;
    }
    if (typeof value === "object" && value.__firestoreType === "timestamp") {
      out[key] = { timestampValue: value.value };
      continue;
    }
    out[key] = { stringValue: JSON.stringify(value) };
  }
  return out;
}

test("dedupeLeaderboard dry-run never fires a :commit call", async () => {
  const { fetchImpl, commits } = createMockFetch({
    "1v1": [
      {
        _docId: "gp-1_1v1", playlist: "1v1", name: "P", mmr: 1000,
        rgPlayerId: "gp-1", lastWriteAt: "2026-01-01T00:00:00.000Z",
      },
      {
        _docId: "authUidA_1v1", playlist: "1v1", name: "P", mmr: 1234,
        rgPlayerId: "gp-1", lastWriteAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    "2v2": [],
    "3v3": [],
    "wins": [],
  });
  const logs = [];
  const result = await dedupeLeaderboard({
    project: "rgleaderboard",
    apply: false,
    fetchImpl,
    getToken: async () => "mock-token",
    logger: { log: (line) => logs.push(line) },
  });
  assert.equal(commits.length, 0);
  assert.equal(result.totalDeletes, 1);
  assert.equal(result.applied, 0);
  const plan1v1 = result.plans.find(p => p.playlist === "1v1");
  assert.equal(plan1v1.plans[0].keep.docId, "authUidA_1v1");
  assert.equal(plan1v1.plans[0].deletes[0].docId, "gp-1_1v1");
});

test("dedupeLeaderboard --apply commits deletes for the older docs", async () => {
  const { fetchImpl, commits } = createMockFetch({
    "1v1": [
      {
        _docId: "gp-1_1v1", playlist: "1v1", name: "P", mmr: 1000,
        rgPlayerId: "gp-1", lastWriteAt: "2026-01-01T00:00:00.000Z",
      },
      {
        _docId: "authUidA_1v1", playlist: "1v1", name: "P", mmr: 1234,
        rgPlayerId: "gp-1", lastWriteAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    "2v2": [],
    "3v3": [],
    "wins": [],
  });
  const result = await dedupeLeaderboard({
    project: "rgleaderboard",
    apply: true,
    fetchImpl,
    getToken: async () => "mock-token",
    logger: { log: () => {} },
  });
  assert.equal(result.applied, 1);
  assert.equal(commits.length, 1);
  const [commit] = commits;
  assert.equal(commit.writes.length, 1);
  assert.match(commit.writes[0].delete, /leaderboard\/gp-1_1v1$/);
});
