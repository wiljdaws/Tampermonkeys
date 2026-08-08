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
  parseCacheArguments,
  planCacheWrite,
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
  let commitBody = null;
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
      commitBody = JSON.parse(options.body);
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
  assert.equal(commitBody.writes.length, 1);
  assert.match(
    commitBody.writes[0].update.name,
    /leaderboard_cache\/1v1$/,
  );
});
