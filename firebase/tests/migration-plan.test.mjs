import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  clanNameReservationId,
  deterministicLeaderboardId,
  migrateClanShape,
  normalizeClanName,
  normalizeClanTag,
  planFixture,
  TARGET_VERSION,
} from "../scripts/plan-migrations.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const fixturePath = path.join(
  testDirectory,
  "fixtures",
  "firestore-shapes.json",
);
const conflictFixturePath = path.join(
  testDirectory,
  "fixtures",
  "migration-conflicts.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const conflictFixture = JSON.parse(
  await readFile(conflictFixturePath, "utf8"),
);

test("fixture is sanitized and keeps audited shape counts", () => {
  assert.equal(fixture.metadata.containsProductionValues, false);
  assert.equal(fixture.leaderboard.length, 11);
  assert.equal(fixture.script_submissions.length, 3);
  assert.equal(fixture.clans.length, 8);
});

test("deterministic leaderboard IDs include the playlist", () => {
  assert.equal(
    deterministicLeaderboardId("player-a", "3v3"),
    "player-a_3v3",
  );
  assert.throws(() => deterministicLeaderboardId("player-a", ""));
});

test("migration tag normalization matches ATLAS and final rules", () => {
  assert.equal(normalizeClanTag(" [a1-bc!] "), "ABC");
  assert.equal(normalizeClanTag("long-tag"), "LONG");
});

test("leaderboard plan preserves manual rows and reports duplicate choices", () => {
  const plan = planFixture(fixture);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.containsProductionWrites, false);
  assert.equal(plan.leaderboard.summary.inputDocuments, 11);
  assert.equal(plan.leaderboard.summary.manualDocuments, 2);
  assert.deepEqual(
    plan.leaderboard.manualPreserved.map(row => row.id).sort(),
    ["manual-mmr", "manual-wins"],
  );

  const conflict = plan.leaderboard.conflicts[0];
  assert.equal(conflict.targetId, "player-b_1v1");
  assert.equal(conflict.recommendation.selectedId, "duplicate-new");
  assert.equal(conflict.status, "unresolved");
  const conflictOperations = plan.leaderboard.operations.filter(
    operation => operation.conditional?.conflictId === conflict.id,
  );
  assert.ok(conflictOperations.length > 0);
  assert.ok(conflictOperations.every(operation => operation.destructive));
  assert.ok(conflictOperations.every(operation =>
    operation.precondition?.exists === false
    || /^[a-f0-9]{64}$/.test(operation.precondition?.sha256)));

  const recommended = conflict.alternatives.find(
    alternative =>
      alternative.selectedId === conflict.recommendation.selectedId,
  );
  const recommendedWrite = conflictOperations.find(
    operation =>
      recommended.operationIds.includes(operation.id)
      && operation.action === "set",
  );
  assert.equal(recommendedWrite.document.mmr, 950);
  assert.equal(recommendedWrite.document.glowColor, "#00bfff");
});

test("leaderboard rekeys are destructive and need expected preconditions", () => {
  const plan = planFixture({
    leaderboard: [{
      id: "legacy-row",
      sourceUserId: "player-a",
      playlist: "2v2",
      name: "Player A",
      mmr: 1200,
      flag: "US",
      glowColor: "#00bfff",
    }],
  });
  const [write, removal] = plan.operations;
  assert.equal(write.path, "leaderboard/player-a_2v2");
  assert.equal(write.document.flag, "US");
  assert.equal(write.document.glowColor, "#00bfff");
  assert.equal(write.destructive, true);
  assert.deepEqual(write.precondition, { exists: false });
  assert.equal(removal.action, "delete");
  assert.equal(removal.path, "leaderboard/legacy-row");
  assert.equal(removal.precondition.exists, true);
  assert.match(removal.precondition.sha256, /^[a-f0-9]{64}$/);
});

test("manual deterministic-ID collisions block rekeys", () => {
  const plan = planFixture({
    leaderboard: [
      {
        id: "player-a_2v2",
        playlist: "2v2",
        name: "Manual Row",
        mmr: 1500,
      },
      {
        id: "legacy-row",
        sourceUserId: "player-a",
        playlist: "2v2",
        name: "Player A",
        mmr: 1200,
      },
    ],
  });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.unresolvedConflicts.length, 1);
  assert.equal(
    plan.unresolvedConflicts[0].type,
    "leaderboard-target-collision",
  );
  assert.equal(plan.unresolvedConflicts[0].manualOnly, true);
  assert.equal(
    plan.unresolvedConflicts[0].recommendation.selectedId,
    "player-a_2v2",
  );
});

test("clans without known devices are blockers, not invented migrations", () => {
  const plan = planFixture(fixture);

  assert.equal(plan.clans.summary.clans, 8);
  assert.equal(plan.clans.summary.migratableClans, 0);
  assert.equal(plan.clans.summary.blockedClans, 8);
  assert.equal(plan.clans.summary.missingDeviceMembers, 19);
  assert.equal(plan.clans.operations.length, 0);
  assert.equal(plan.blockers.length, 19);
  assert.ok(plan.clans.missingDeviceMembers.every(item =>
    !("inventedDeviceId" in item)));
});

test("members above the device lock limit block instead of truncating", () => {
  const plan = planFixture({
    clans: [{
      id: "clan-many-devices",
      name: "Many Devices",
      tag: "MNY",
      leaderId: "player-a",
      members: [{
        userId: "player-a",
        role: "leader",
        deviceIds: [
          "device-1",
          "device-2",
          "device-3",
          "device-4",
          "device-5",
          "device-6",
        ],
      }],
    }],
  });
  assert.equal(plan.clans.operations.length, 0);
  assert.equal(plan.clans.excessDeviceMembers[0].knownDeviceCount, 6);
  assert.equal(plan.blockers[0].type, "device-lock-limit");
});

test("clans that cannot satisfy final rules are blocked before planning writes", () => {
  const plan = planFixture({
    clans: [{
      id: "bad-shape",
      name: "Bad Clan",
      tag: "1",
      leaderId: "missing-leader",
      members: [{
        userId: "player-a",
        role: "unknown",
        deviceId: "device-a",
      }],
    }],
  });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.blockers[0].type, "invalid-clan-shape");
  assert.deepEqual(plan.blockers[0].reasons, [
    "invalid-tag",
    "invalid-leader",
    "invalid-role",
  ]);
});

test("clan output matches map, scoring, lock, and shard contracts", () => {
  const source = {
    id: "clan-ready",
    name: "Ready Clan",
    tag: "rdy",
    createdAt: "2026-01-01T00:00:00.000Z",
    leaderId: "player-a",
    members: [
      {
        userId: "player-a",
        name: "Player A",
        role: "leader",
        mmr: 4200,
        syncedAt: 100,
        deviceId: "device-a",
      },
      {
        userId: "player-b",
        name: "Player B",
        role: "member",
        mmr: 3900,
        deviceIds: ["device-b", "device-b-alt"],
      },
    ],
    memberStats: {
      "player-a": {
        mmr: 4300,
        syncedAt: 200,
        deviceIds: ["device-a"],
      },
    },
    eventBaseline: {
      "player-a": 4000,
      "player-b": 3800,
    },
    totalMMR: 8100,
    tagStyle: {
      mode: "solid",
      color: "#00bfff",
    },
  };
  const plan = planFixture({ clans: [source] });
  assert.equal(plan.clans.summary.migratableClans, 1);
  assert.equal(plan.clans.summary.directoryDocuments, 1);
  assert.equal(plan.clans.summary.membershipDocuments, 2);
  assert.equal(plan.clans.summary.deviceDocuments, 3);

  const migrated = plan.clans.clanWrites[0].document;
  assert.equal(Array.isArray(migrated.members), false);
  assert.equal(migrated.members["player-a"].mmr, 4200);
  assert.equal(migrated.memberStats["player-a"].mmr, 4300);
  assert.equal(migrated.members["player-a"].eventBaseline, 4000);
  assert.equal(migrated.members["player-b"].eventBaseline, 3800);
  assert.deepEqual(migrated.eventBaseline, source.eventBaseline);
  assert.equal(migrated.totalMMR, 8100);
  assert.deepEqual(migrated.tagStyle, source.tagStyle);
  assert.equal("joinMMR" in migrated.members["player-a"], false);
  assert.equal("retainedMMR" in migrated, false);
  assert.equal(migrated.versionNum, TARGET_VERSION);
  assert.equal(migrated.lockVersion, 1);
  assert.equal(migrated.tag, "RDY");
  assert.equal(migrated.tagKey, "RDY");
  assert.equal(migrated.nameKey, clanNameReservationId("Ready Clan"));
  assert.deepEqual(
    migrated.memberIds,
    Object.keys(migrated.members),
  );
  assert.deepEqual(
    migrated.deviceIds,
    ["device-a", "device-b", "device-b-alt"],
  );

  const shard = plan.clans.directoryWrites[0];
  assert.equal(shard.targetId, "clan-ready");
  assert.equal(shard.document.clanId, "clan-ready");
  assert.deepEqual(shard.document.memberIds, migrated.memberIds);
  assert.deepEqual(shard.document.deviceIds, migrated.deviceIds);
  assert.equal(
    plan.operations.some(operation =>
      operation.path === "clans_directory/index"),
    false,
  );
});

test("clan shape conversion is idempotent and preserves legacy baseline", () => {
  const first = migrateClanShape({
    id: "clan-a",
    name: "Clan A",
    tag: "AAA",
    leaderId: "player-a",
    members: [{
      userId: "player-a",
      role: "leader",
      mmr: 4100,
      deviceId: "device-a",
    }],
    eventBaseline: { "player-a": 4000 },
    totalMMR: 4100,
  });
  const second = migrateClanShape(first);
  assert.deepEqual(second, first);
  assert.deepEqual(second.eventBaseline, { "player-a": 4000 });
});

test("sanitized established-versus-test device conflict is reported", () => {
  assert.equal(
    conflictFixture.metadata.containsProductionValues,
    false,
  );
  const plan = planFixture(conflictFixture);
  const conflict = plan.clans.conflicts.find(
    item => item.type === "device-membership",
  );
  assert.ok(conflict);
  assert.equal(conflict.deviceId, "device-shared");
  assert.deepEqual(
    conflict.candidateIds,
    ["clan-established", "clan-newer-test"],
  );
  assert.equal(
    conflict.recommendation.selectedId,
    "clan-established",
  );
  assert.match(conflict.recommendation.reason, /Oldest createdAt/);
  assert.equal(conflict.manualOnly, true);
  assert.deepEqual(conflict.destructivePaths, [
    "clans/clan-newer-test",
  ]);
  assert.equal(conflict.proposedDeletions[0].requiresExplicitApproval, true);
  assert.match(
    conflict.proposedDeletions[0].precondition.sha256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(plan.clans.operations.length, 0);
});

test("established clan recommendation falls back to stable ID", () => {
  const plan = planFixture({
    clans: [
      {
        id: "clan-z",
        name: "Duplicate Name",
        tag: "ZZZ",
        leaderId: "player-z",
        createdAt: "2026-01-01T00:00:00.000Z",
        members: [{
          userId: "player-z",
          role: "leader",
          deviceId: "device-z",
        }],
      },
      {
        id: "clan-a",
        name: " duplicate   name ",
        tag: "AAA",
        leaderId: "player-a",
        createdAt: "2026-01-01T00:00:00.000Z",
        members: [{
          userId: "player-a",
          role: "leader",
          deviceId: "device-a",
        }],
      },
    ],
  });
  const conflict = plan.clans.conflicts.find(
    item => item.type === "duplicate-name",
  );
  assert.equal(normalizeClanName(" duplicate   name "), "duplicate name");
  assert.equal(conflict.recommendation.selectedId, "clan-a");
  assert.equal(plan.clans.operations.length, 0);
});

test("playlist and wins descending index is additive", async () => {
  const indexes = JSON.parse(
    await readFile(path.join(workspace, "firestore.indexes.json"), "utf8"),
  ).indexes;
  const keys = indexes.map(index =>
    index.fields.map(field =>
      `${field.fieldPath}:${field.order}`).join("|"));
  assert.ok(keys.includes("playlist:ASCENDING|mmr:ASCENDING"));
  assert.ok(keys.includes("playlist:ASCENDING|mmr:DESCENDING"));
  assert.ok(keys.includes("playlist:ASCENDING|wins:DESCENDING"));
});

test("planner refuses production-style arguments", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/plan-migrations.mjs", "--apply"],
    {
      cwd: workspace,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot mutate production/);
});
