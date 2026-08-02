import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildOperationBudget,
  captureSnapshot,
  decodeFirestoreDocument,
  parseSnapshotArguments,
  runSnapshotCommand,
  SNAPSHOT_TARGETS,
  snapshotsDirectory,
} from "../scripts/snapshot-production.mjs";
import {
  compareSnapshots,
  loadSnapshotInput,
  parseVerifyArguments,
  snapshotParity,
} from "../scripts/verify-baseline.mjs";

function collection(pathName, entries) {
  return {
    kind: "collection",
    path: pathName,
    documents: entries.map(([id, fields]) => ({
      id,
      path: `${pathName}/${id}`,
      createTime: null,
      updateTime: null,
      fields,
    })),
  };
}

function document(pathName, fields) {
  const id = pathName.split("/").at(-1);
  return {
    kind: "document",
    path: pathName,
    document: fields
      ? {
        id,
        path: pathName,
        createTime: null,
        updateTime: null,
        fields,
      }
      : null,
  };
}

function baselineSnapshot() {
  const clan = {
    name: "Alpha Omega",
    tag: "AO",
    leaderId: "player-a",
    members: [{
      userId: "player-a",
      name: "Alpha",
      role: "leader",
      mmr: 4200,
      eventBaseline: 4000,
      deviceId: "device-a",
    }],
    totalMMR: 4200,
  };
  const nameKey = createHash("sha256")
    .update("alpha omega")
    .digest("hex");
  const targets = {
    "events/current": document("events/current", {
      active: true,
      startTime: 1,
      endTime: 2,
    }),
    clans: collection("clans", [["clan-a", clan]]),
    clans_directory: collection("clans_directory", [[
      "clan-a",
      {
        name: "Alpha Omega",
        tag: "AO",
        memberCount: 1,
        memberIds: ["player-a"],
        deviceIds: ["device-a"],
      },
    ]]),
    clan_name_keys: collection("clan_name_keys", [[
      nameKey,
      {
        clanId: "clan-a",
        name: "Alpha Omega",
        normalizedName: "alpha omega",
      },
    ]]),
    clan_tag_keys: collection("clan_tag_keys", [[
      "AO",
      { clanId: "clan-a", tag: "AO" },
    ]]),
    clan_memberships: collection("clan_memberships", [[
      "player-a",
      {
        clanId: "clan-a",
        role: "leader",
        deviceIds: ["device-a"],
      },
    ]]),
    clan_devices: collection("clan_devices", [[
      "device-a",
      { clanId: "clan-a", userId: "player-a" },
    ]]),
    clan_notices: collection("clan_notices", [[
      "player-a",
      {
        type: "kicked",
        clanId: "clan-old",
        clanName: "Old Clan",
      },
    ]]),
    leaderboard: collection("leaderboard", [[
      "player-a_3v3",
      {
        sourceUserId: "player-a",
        playlist: "3v3",
        mmr: 4200,
      },
    ]]),
    script_submissions: collection("script_submissions", [[
      "player-a",
      { sourceUserId: "player-a" },
    ]]),
    atlas_config: collection("atlas_config", [["hud", { popupEnabled: true }]]),
    "admin/blacklist": document("admin/blacklist", {
      minVersion: 16,
    }),
  };
  const collectionCounts = Object.fromEntries(
    Object.entries(targets).map(([key, target]) => [
      key,
      target.kind === "document"
        ? Number(Boolean(target.document))
        : target.documents.length,
    ]),
  );
  return {
    schemaVersion: 1,
    mode: "read-only",
    project: "sample-project",
    database: "(default)",
    capturedAt: "2026-08-02T20:00:00.000Z",
    collectionCounts,
    operationBudget: buildOperationBudget(targets),
    targets,
  };
}

test("snapshot arguments require a project and reject mutation flags", () => {
  assert.ok(SNAPSHOT_TARGETS.some(target =>
    target.key === "clan_notices"
    && target.kind === "collection"
    && target.path === "clan_notices"));
  assert.deepEqual(parseSnapshotArguments([]), { help: true });
  assert.deepEqual(parseSnapshotArguments(["--help"]), { help: true });
  assert.deepEqual(
    parseSnapshotArguments(["--project", "sample-project"]),
    { help: false, project: "sample-project" },
  );
  assert.throws(
    () => parseSnapshotArguments(["--project", "sample-project", "--deploy"]),
    /blocked/,
  );
  assert.throws(
    () => parseSnapshotArguments(["--project"]),
    /requires one explicit project ID/,
  );
});

test("help and default snapshot commands never request a token", async () => {
  let tokenRequested = false;
  const getAccessToken = async () => {
    tokenRequested = true;
    throw new Error("must not run");
  };
  assert.deepEqual(
    await runSnapshotCommand([], { getAccessToken }),
    { help: true },
  );
  assert.deepEqual(
    await runSnapshotCommand(["--help"], { getAccessToken }),
    { help: true },
  );
  assert.equal(tokenRequested, false);
});

test("Firestore values decode without losing document identity", () => {
  const decoded = decodeFirestoreDocument({
    name:
      "projects/sample-project/databases/(default)/documents/clans/clan-a",
    createTime: "2026-08-02T20:00:00.000Z",
    updateTime: "2026-08-02T20:01:00.000Z",
    fields: {
      active: { booleanValue: true },
      count: { integerValue: "3" },
      members: {
        arrayValue: {
          values: [{ stringValue: "player-a" }],
        },
      },
      nested: {
        mapValue: {
          fields: {
            mmr: { doubleValue: 4200.5 },
          },
        },
      },
      lastWriteAt: {
        timestampValue: "2026-08-02T20:01:00.000Z",
      },
    },
  });
  assert.equal(decoded.id, "clan-a");
  assert.equal(decoded.path, "clans/clan-a");
  assert.deepEqual(decoded.fields, {
    active: true,
    count: 3,
    members: ["player-a"],
    nested: { mmr: 4200.5 },
    lastWriteAt: {
      __firestoreType: "timestamp",
      value: "2026-08-02T20:01:00.000Z",
    },
  });
});

test("baseline comparison covers roster, parity, counts, and budgets", () => {
  const before = baselineSnapshot();
  const unchanged = structuredClone(before);
  const equalReport = compareSnapshots(before, unchanged);
  assert.equal(equalReport.equal, true);
  assert.equal(equalReport.afterParityExact, true);
  assert.deepEqual(snapshotParity(unchanged), {
    directory: { exact: true, issues: [] },
    reservations: {
      exact: true,
      issues: {
        clan_name_keys: [],
        clan_tag_keys: [],
        clan_memberships: [],
        clan_devices: [],
      },
    },
  });

  const after = structuredClone(before);
  after.targets.clans.documents[0].fields.members[0].mmr = 4300;
  after.targets.clans_directory.documents[0].fields.memberIds = [];
  after.collectionCounts.leaderboard = 2;
  after.operationBudget.clientReadUpperBounds.mainLeaderboardFullLoad = 3;
  const report = compareSnapshots(before, after);
  assert.equal(report.equal, false);
  assert.equal(report.counts.equal, false);
  assert.equal(report.clanRosterAndScoring.equal, false);
  assert.equal(report.directory.equal, false);
  assert.equal(report.directory.afterParity.exact, false);
  assert.equal(report.operationBudget.equal, false);
});

test("manifest loading verifies hashes and collection counts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-snapshot-"));
  try {
    const snapshot = baselineSnapshot();
    const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
    const metadataText = "{}\n";
    await writeFile(path.join(directory, "snapshot.json"), snapshotText);
    await writeFile(path.join(directory, "metadata.json"), metadataText);
    const manifest = {
      hashAlgorithm: "sha256",
      collectionCounts: snapshot.collectionCounts,
      files: [
        {
          path: "snapshot.json",
          sha256: createHash("sha256").update(snapshotText).digest("hex"),
          bytes: Buffer.byteLength(snapshotText),
        },
        {
          path: "metadata.json",
          sha256: createHash("sha256").update(metadataText).digest("hex"),
          bytes: Buffer.byteLength(metadataText),
        },
      ],
    };
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual(await loadSnapshotInput(manifestPath), snapshot);

    await writeFile(path.join(directory, "metadata.json"), '{"changed":true}\n');
    await assert.rejects(
      loadSnapshotInput(manifestPath),
      /SHA-256 mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("baseline CLI accepts only two local inputs", () => {
  assert.deepEqual(parseVerifyArguments([]), { help: true });
  assert.deepEqual(parseVerifyArguments(["before.json", "after.json"]), {
    help: false,
    before: "before.json",
    after: "after.json",
  });
  assert.throws(
    () => parseVerifyArguments(["before.json", "--apply"]),
    /blocked/,
  );
  assert.throws(
    () => parseVerifyArguments(["only-one.json"]),
    /exactly two/,
  );
});

test("snapshot capture uses GET and writes only to ignored snapshots", async () => {
  const requests = [];
  const now = new Date("2099-01-02T03:04:05.678Z");
  const expectedDirectory = path.join(
    snapshotsDirectory,
    "2099-01-02T03-04-05-678Z-sample-project",
  );
  await rm(expectedDirectory, { recursive: true, force: true });
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    const pathname = new URL(url).pathname;
    let body = {};
    if (pathname.endsWith("/documents/events/current")) {
      body = {
        name:
          "projects/sample-project/databases/(default)/documents/events/current",
        fields: { active: { booleanValue: true } },
      };
    } else if (pathname.endsWith("/documents/admin/blacklist")) {
      body = {
        name:
          "projects/sample-project/databases/(default)/documents/admin/blacklist",
        fields: { minVersion: { integerValue: "16" } },
      };
    } else if (pathname.endsWith("/documents/admin/clanPerms")
               || pathname.endsWith("/documents/admin/migration")) {
      return {
        ok: false,
        status: 404,
        text: async () => "{}",
      };
    } else if (pathname.endsWith("/releases")) {
      body = { releases: [] };
    } else if (pathname.endsWith("/indexes")) {
      body = { indexes: [] };
    } else {
      body = { documents: [] };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };

  try {
    const result = await captureSnapshot({
      project: "sample-project",
      fetchImpl,
      getAccessToken: async () => "secret-test-token",
      now,
    });
    assert.equal(result.outputDirectory, expectedDirectory);
    assert.ok(requests.length >= 14);
    assert.ok(requests.every(request => request.options.method === "GET"));
    assert.ok(requests.every(
      request =>
        request.options.headers.Authorization === "Bearer secret-test-token",
    ));
    const manifestText = await readFile(
      path.join(result.outputDirectory, "manifest.json"),
      "utf8",
    );
    const snapshotText = await readFile(
      path.join(result.outputDirectory, "snapshot.json"),
      "utf8",
    );
    assert.doesNotMatch(manifestText, /secret-test-token/);
    assert.doesNotMatch(snapshotText, /secret-test-token/);
    assert.equal(result.manifest.collectionCounts["events/current"], 1);
    assert.equal(result.manifest.collectionCounts["admin/blacklist"], 1);
    assert.equal(result.manifest.collectionCounts.clan_notices, 0);
  } finally {
    await rm(expectedDirectory, { recursive: true, force: true });
  }
});
