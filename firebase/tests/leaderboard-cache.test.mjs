import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_COLLECTION,
  assertCacheDocumentSize,
  buildCacheDocument,
  buildIconKeyManifest,
  buildJsonRow,
  buildLeaderboardCaches,
  buildLeaderboardJson,
  compactLeaderboardRow,
  maxLastWriteAt,
  mergeSnapshot,
  parseCacheArguments,
  planCacheWrite,
  sortSnapshotForPlaylist,
  sourceHashForRows,
} from "../scripts/build-leaderboard-cache.mjs";

test("parseCacheArguments defaults to dry-run and validates playlists", () => {
  assert.deepEqual(
    parseCacheArguments(["--project", "rgleaderboard"]),
    {
      help: false,
      project: "rgleaderboard",
      apply: false,
      playlists: ["1v1", "2v2", "3v3"],
      top: 100,
      emitJson: false,
      skipFirestore: false,
      jsonPrefix: "leaderboard/",
      outputDir: "",
      stateDir: "",
      forceFull: false,
    },
  );
  assert.equal(parseCacheArguments(["--help"]).help, true);
  assert.throws(
    () => parseCacheArguments(["--project", "rgleaderboard", "--playlists", "4v4"]),
    /Unsupported playlist/,
  );
  assert.throws(
    () => parseCacheArguments(["--project", "rgleaderboard", "--write"]),
    /blocked/,
  );
  // In firestore-only mode wins is rejected, but --emit-json opens it up.
  assert.throws(
    () => parseCacheArguments(["--project", "rgleaderboard", "--playlists", "wins"]),
    /Unsupported playlist/,
  );
  const emitParsed = parseCacheArguments([
    "--project",
    "rgleaderboard",
    "--emit-json",
    "--playlists",
    "wins",
  ]);
  assert.equal(emitParsed.emitJson, true);
  assert.deepEqual(emitParsed.playlists, ["wins"]);
  assert.throws(
    () => parseCacheArguments(["--project", "rgleaderboard", "--skip-firestore"]),
    /--skip-firestore requires --emit-json/,
  );
});

test("compact rows drop streak fields and hash only ranking payload", () => {
  const row = compactLeaderboardRow({
    sourceUserId: "player-a",
    name: "Ace",
    mmr: 1500.4,
    currentStreak: 12,
    stats: { wins: 9 },
  }, 1);
  assert.deepEqual(row, {
    uid: "player-a",
    name: "Ace",
    mmr: 1500,
    rank: 1,
  });
  assert.equal(
    sourceHashForRows([row]),
    sourceHashForRows([{ ...row, currentStreak: 99 }]),
  );
});

test("planCacheWrite skips unchanged sourceHash and guards size", () => {
  const document = buildCacheDocument("1v1", [
    { sourceUserId: "a", name: "A", mmr: 1200 },
    { sourceUserId: "b", name: "B", mmr: 1100 },
  ], { builtAt: "2026-08-04T00:00:00.000Z" });
  assert.equal(document.rowCount, 2);
  assert.equal(document.rows[0].rank, 1);
  assert.equal(
    planCacheWrite({
      sourceHash: document.sourceHash,
      rowCount: document.rowCount,
      schemaVersion: document.schemaVersion,
    }, document).action,
    "skip",
  );
  assert.equal(
    planCacheWrite({ sourceHash: "different" }, document).action,
    "write",
  );
  assert.ok(assertCacheDocumentSize(document) < 10_000);
});

test("iconKey manifest is deterministic and compact", () => {
  const manifest = buildIconKeyManifest([
    { id: "b", icon: "https://example.com/b.png", label: "B" },
    { id: "a", icon: "https://example.com/a.png", label: "A" },
  ], { builtAt: "2026-08-04T00:00:00.000Z" });
  assert.equal(manifest.playlist, "iconKey");
  assert.deepEqual(manifest.rows.map(row => row.id), ["a", "b"]);
  assert.equal(
    planCacheWrite({
      sourceHash: manifest.sourceHash,
      rowCount: manifest.rowCount,
      schemaVersion: manifest.schemaVersion,
    }, manifest).action,
    "skip",
  );
});

test("buildLeaderboardCaches dry-run plans writes without commit", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url).includes(":runQuery")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify([
            {
              document: {
                name: "projects/rgleaderboard/databases/(default)/documents/leaderboard/a_1v1",
                fields: {
                  sourceUserId: { stringValue: "a" },
                  name: { stringValue: "Ace" },
                  mmr: { integerValue: "1500" },
                  playlist: { stringValue: "1v1" },
                  currentStreak: { integerValue: "7" },
                },
              },
            },
          ]);
        },
      };
    }
    if (String(url).includes(`/${CACHE_COLLECTION}/`)) {
      return {
        ok: true,
        status: 404,
        async text() {
          return "";
        },
      };
    }
    if (String(url).includes("/documents/iconKey")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            documents: [
              {
                name: "projects/rgleaderboard/databases/(default)/documents/iconKey/champ",
                fields: {
                  icon: { stringValue: "https://example.com/c.png" },
                  label: { stringValue: "Champ" },
                },
              },
            ],
          });
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await buildLeaderboardCaches({
    project: "rgleaderboard",
    apply: false,
    playlists: ["1v1"],
    fetchImpl,
    getToken: async () => "token",
    includeIconKey: true,
    now: () => "2026-08-04T12:00:00.000Z",
  });

  assert.equal(result.written, 0);
  assert.equal(result.plannedWrites, 2);
  assert.equal(result.plans[0].document.rows[0].uid, "a");
  assert.equal(result.plans[0].document.rows[0].currentStreak, undefined);
  assert.ok(!calls.some(call => call.url.includes(":commit")));
});

test("buildJsonRow preserves flag/icons/glow and switches shape for wins", () => {
  const mmrRow = buildJsonRow({
    sourceUserId: "a",
    name: "Ace",
    mmr: 1500.6,
    flag: "US",
    icons: "champion",
    iconSize: 18,
    glowColor: "#00bfff",
    glowStrength: 3,
    currentStreak: 5,
  }, 1, "1v1");
  assert.deepEqual(mmrRow, {
    rank: 1,
    uid: "a",
    name: "Ace",
    mmr: 1501,
    flag: "US",
    icons: "champion",
    iconSize: 18,
    glowColor: "#00bfff",
    glowStrength: 3,
    currentStreak: 5,
  });
  const winsRow = buildJsonRow({
    sourceUserId: "b",
    name: "Bravo",
    wins: 75,
    matches: 100,
  }, 4, "wins");
  assert.deepEqual(winsRow, {
    rank: 4,
    uid: "b",
    name: "Bravo",
    wins: 75,
    matches: 100,
  });
  assert.equal(buildJsonRow({ name: "no uid" }, 1, "1v1"), null);

  // Legacy admin rows have no sourceUserId/uid; fall back to the Firestore
  // doc id so they still make it into the JSON instead of leaving a gap.
  const legacyRow = buildJsonRow({
    _docId: "manual_top_dog",
    name: "Legacy Admin",
    mmr: 22000,
  }, 1, "1v1");
  assert.equal(legacyRow.uid, "manual_top_dog");
  assert.equal(legacyRow.mmr, 22000);

  const legacyCompact = compactLeaderboardRow({
    _docId: "manual_top_dog",
    name: "Legacy Admin",
    mmr: 22000,
  }, 1);
  assert.equal(legacyCompact.uid, "manual_top_dog");
});

test("mergeSnapshot upserts by _docId and preserves untouched rows", () => {
  const prior = [
    { _docId: "a", name: "Ace", mmr: 1500 },
    { _docId: "b", name: "Bravo", mmr: 1400 },
  ];
  const delta = [
    { _docId: "b", name: "Bravo", mmr: 1450 },  // updated
    { _docId: "c", name: "Charlie", mmr: 1350 }, // new
  ];
  const merged = mergeSnapshot(prior, delta);
  assert.equal(merged.length, 3);
  const byId = new Map(merged.map(row => [row._docId, row]));
  assert.equal(byId.get("a").mmr, 1500);
  assert.equal(byId.get("b").mmr, 1450);
  assert.equal(byId.get("c").mmr, 1350);
});

test("mergeSnapshot ignores rows without _docId", () => {
  const merged = mergeSnapshot(
    [{ _docId: "a", mmr: 1 }],
    [{ name: "no-id" }, { _docId: "b", mmr: 2 }],
  );
  assert.equal(merged.length, 2);
});

test("sortSnapshotForPlaylist sorts by mmr desc for ranked, wins desc for wins", () => {
  const rows = [
    { _docId: "a", mmr: 100, wins: 5 },
    { _docId: "b", mmr: 300, wins: 2 },
    { _docId: "c", mmr: 200, wins: 8 },
  ];
  const byMmr = sortSnapshotForPlaylist(rows, "1v1");
  assert.deepEqual(byMmr.map(r => r._docId), ["b", "c", "a"]);
  const byWins = sortSnapshotForPlaylist(rows, "wins");
  assert.deepEqual(byWins.map(r => r._docId), ["c", "a", "b"]);
});

test("sortSnapshotForPlaylist wins ties break on fewer matches then name", () => {
  // Reported bug: [OG]... 7/10 came out below HAMZAEG 7/12 because ties
  // fell through to name. Fewer matches → better rank now.
  const rows = [
    { _docId: "hamzaeg", name: "HAMZAEG", wins: 7, matches: 12 },
    { _docId: "og", name: "[OG] ....", wins: 7, matches: 10 },
    { _docId: "future", name: "FutureDemon.5FP", wins: 0, matches: 1 },
    { _docId: "jajaa", name: "Jajaa", wins: 0, matches: 1 },
  ];
  const sorted = sortSnapshotForPlaylist(rows, "wins");
  assert.deepEqual(
    sorted.map(r => r._docId),
    ["og", "hamzaeg", "future", "jajaa"],
  );
});

test("sortSnapshotForPlaylist is stable across shuffled inputs", () => {
  const rows = [
    { _docId: "a", name: "Alpha", mmr: 1000 },
    { _docId: "b", name: "Alpha", mmr: 1000 },
    { _docId: "c", name: "Bravo", mmr: 1000 },
  ];
  const first = sortSnapshotForPlaylist(rows, "1v1").map(r => r._docId);
  const shuffled = [rows[2], rows[0], rows[1]];
  const second = sortSnapshotForPlaylist(shuffled, "1v1").map(r => r._docId);
  assert.deepEqual(second, first);
});

test("maxLastWriteAt handles decoded timestamp objects and strings", () => {
  const wrapped = [
    { lastWriteAt: { __firestoreType: "timestamp", value: "2026-08-08T20:00:00Z" } },
    { lastWriteAt: { __firestoreType: "timestamp", value: "2026-08-08T21:00:00Z" } },
    { lastWriteAt: null },
    { /* no lastWriteAt */ },
  ];
  assert.equal(maxLastWriteAt(wrapped), "2026-08-08T21:00:00Z");
  assert.equal(
    maxLastWriteAt([{ lastWriteAt: "2026-08-08T22:00:00Z" }]),
    "2026-08-08T22:00:00Z",
  );
  assert.equal(maxLastWriteAt([]), null);
});

test("buildLeaderboardJson hashes over ranking fields only", () => {
  const base = [
    { sourceUserId: "a", name: "Ace", mmr: 1500 },
    { sourceUserId: "b", name: "Bravo", mmr: 1400 },
  ];
  const first = buildLeaderboardJson("1v1", base, { builtAt: "T" });
  const cosmeticChange = buildLeaderboardJson("1v1", [
    { ...base[0], flag: "CA", glowColor: "#ffffff" },
    base[1],
  ], { builtAt: "T" });
  assert.equal(first.sourceHash, cosmeticChange.sourceHash);
  const rankingChange = buildLeaderboardJson("1v1", [
    { ...base[0], mmr: 1600 },
    base[1],
  ], { builtAt: "T" });
  assert.notEqual(first.sourceHash, rankingChange.sourceHash);
  assert.equal(first.rows[0].rank, 1);
  assert.equal(first.rowCount, 2);
});

test("buildLeaderboardJson renumbers ranks after dropping soft-deleted rows", () => {
  // Reported bug: rank #67 was missing because rank was assigned before
  // buildJsonRow filtered a null row.
  const rows = [
    { sourceUserId: "a", name: "A", mmr: 1500 },
    { sourceUserId: "b", name: "B", mmr: 1400, deleted: true },
    { sourceUserId: "c", name: "C", mmr: 1300 },
  ];
  const result = buildLeaderboardJson("1v1", rows, { builtAt: "T" });
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows.map(r => r.rank), [1, 2]);
  assert.deepEqual(result.rows.map(r => r.uid), ["a", "c"]);
});

test("buildCacheDocument renumbers ranks after dropping soft-deleted rows", () => {
  const rows = [
    { sourceUserId: "a", name: "A", mmr: 1500 },
    { sourceUserId: "b", name: "B", mmr: 1400, deleted: true },
    { sourceUserId: "c", name: "C", mmr: 1300 },
  ];
  const doc = buildCacheDocument("1v1", rows, { builtAt: "T" });
  assert.equal(doc.rowCount, 2);
  assert.deepEqual(doc.rows.map(r => r.rank), [1, 2]);
});

test("buildJsonRow drops wins-playlist rows missing wins or matches", () => {
  assert.equal(buildJsonRow({ sourceUserId: "a", name: "A", wins: 3 }, 1, "wins"), null);
  assert.equal(buildJsonRow({ sourceUserId: "a", name: "A", matches: 5 }, 1, "wins"), null);
  assert.equal(buildJsonRow({ sourceUserId: "a", name: "A", wins: "x", matches: 5 }, 1, "wins"), null);
});

test("buildJsonRow drops mmr rows missing mmr or uid", () => {
  assert.equal(buildJsonRow({ sourceUserId: "a", name: "A" }, 1, "1v1"), null);
  assert.equal(buildJsonRow({ name: "A", mmr: 1500 }, 1, "1v1"), null);
});

test("buildJsonRow rounds fractional wins/matches/mmr", () => {
  const win = buildJsonRow({ sourceUserId: "a", name: "A", wins: 3.6, matches: 7.4 }, 1, "wins");
  assert.deepEqual({ wins: win.wins, matches: win.matches }, { wins: 4, matches: 7 });
  const mmr = buildJsonRow({ sourceUserId: "b", name: "B", mmr: 1500.6 }, 1, "1v1");
  assert.equal(mmr.mmr, 1501);
});

test("buildJsonRow name field is capped at 120 chars", () => {
  const long = "x".repeat(500);
  const row = buildJsonRow({ sourceUserId: "a", name: long, mmr: 1500 }, 1, "1v1");
  assert.equal(row.name.length, 120);
});

test("buildJsonRow icons array is capped at 12 entries", () => {
  const many = Array.from({ length: 40 }, (_, i) => `icon-${i}`);
  const row = buildJsonRow({ sourceUserId: "a", name: "A", mmr: 1500, icons: many }, 1, "1v1");
  assert.equal(row.icons.length, 12);
});

test("buildLeaderboardJson emits empty rows for an empty input", () => {
  const out = buildLeaderboardJson("1v1", [], { builtAt: "T" });
  assert.equal(out.rowCount, 0);
  assert.deepEqual(out.rows, []);
});

test("buildLeaderboardJson skips rows without uid without breaking rank", () => {
  const rows = [
    { sourceUserId: "a", name: "A", mmr: 1500 },
    { name: "no uid", mmr: 1400 },
    { sourceUserId: "c", name: "C", mmr: 1300 },
  ];
  const out = buildLeaderboardJson("1v1", rows, { builtAt: "T" });
  assert.deepEqual(out.rows.map(r => r.rank), [1, 2]);
  assert.deepEqual(out.rows.map(r => r.uid), ["a", "c"]);
});

test("sortSnapshotForPlaylist keeps rows with non-finite scores at the bottom", () => {
  const rows = [
    { _docId: "nan", name: "Bad", mmr: "not-a-number" },
    { _docId: "hi", name: "Hi", mmr: 2000 },
    { _docId: "lo", name: "Lo", mmr: 100 },
  ];
  const sorted = sortSnapshotForPlaylist(rows, "1v1");
  assert.deepEqual(sorted.map(r => r._docId), ["hi", "lo", "nan"]);
});

test("sortSnapshotForPlaylist handles ties with duplicated names via uid", () => {
  const rows = [
    { _docId: "u2", name: "Same", wins: 5, matches: 10 },
    { _docId: "u1", name: "Same", wins: 5, matches: 10 },
  ];
  const sorted = sortSnapshotForPlaylist(rows, "wins");
  assert.deepEqual(sorted.map(r => r._docId), ["u1", "u2"]);
});

test("buildLeaderboardJson round-trip: shuffled input → identical hash", () => {
  const base = [
    { sourceUserId: "a", name: "A", mmr: 1500 },
    { sourceUserId: "b", name: "B", mmr: 1400 },
    { sourceUserId: "c", name: "C", mmr: 1300 },
  ];
  const first = buildLeaderboardJson("1v1", base, { builtAt: "T" });
  // Publisher sorts before building JSON, so a shuffled input should
  // still hash the same when it's sorted upstream.
  const shuffled = sortSnapshotForPlaylist([base[2], base[0], base[1]], "1v1");
  const second = buildLeaderboardJson("1v1", shuffled, { builtAt: "T" });
  assert.equal(first.sourceHash, second.sourceHash);
});

test("buildLeaderboardCaches --emit-json calls the uploader per playlist", async () => {
  const fetchImpl = async url => {
    if (String(url).includes(":runQuery")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify([
            {
              document: {
                name: "projects/demo/databases/(default)/documents/leaderboard/a_1v1",
                fields: {
                  sourceUserId: { stringValue: "a" },
                  name: { stringValue: "Ace" },
                  mmr: { integerValue: "1500" },
                  playlist: { stringValue: "1v1" },
                  flag: { stringValue: "US" },
                },
              },
            },
          ]);
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const uploads = [];
  const result = await buildLeaderboardCaches({
    project: "rgleaderboard",
    apply: false,
    playlists: ["1v1"],
    fetchImpl,
    getToken: async () => "token",
    includeIconKey: false,
    now: () => "2026-08-04T12:00:00.000Z",
    emitJson: true,
    skipFirestore: true,
    jsonPrefix: "leaderboard/",
    uploadJsonImpl: async (key, obj, opts) => {
      uploads.push({ key, sourceHash: opts.sourceHash, playlist: obj.playlist });
      return { status: 200, etag: "e", url: `mock://${key}` };
    },
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].key, "leaderboard/1v1.json");
  assert.equal(uploads[0].playlist, "1v1");
  assert.equal(result.jsonBlobs[0].blob.rows[0].flag, "US");
  assert.equal(result.uploads[0].action, "uploaded");
});

test("buildLeaderboardCaches --apply commits only changed docs", async () => {
  const commitBodies = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes(":runQuery")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify([
            {
              document: {
                name: "projects/demo/databases/(default)/documents/leaderboard/a_1v1",
                fields: {
                  sourceUserId: { stringValue: "a" },
                  name: { stringValue: "Ace" },
                  mmr: { integerValue: "1500" },
                  playlist: { stringValue: "1v1" },
                },
              },
            },
          ]);
        },
      };
    }
    if (String(url).includes(":commit")) {
      commitBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ writeResults: [{}] });
        },
      };
    }
    if (String(url).includes(`/${CACHE_COLLECTION}/1v1`)) {
      return {
        ok: true,
        status: 404,
        async text() {
          return "";
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await buildLeaderboardCaches({
    project: "rgleaderboard",
    apply: true,
    playlists: ["1v1"],
    fetchImpl,
    getToken: async () => "token",
    includeIconKey: false,
    now: () => "2026-08-04T12:00:00.000Z",
  });

  assert.equal(result.written, 1);
  // pipeline read counter fires a second commit; filter to the cache write
  const cacheWrites = commitBodies.flatMap(body =>
    body.writes.filter(w => /leaderboard_cache\/1v1$/.test(w?.update?.name || "")),
  );
  assert.equal(cacheWrites.length, 1);
  assert.match(cacheWrites[0].update.name, /leaderboard_cache\/1v1$/);
});
