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
  prepareMigration,
  selectApprovedOperations,
} from "../scripts/apply-migrations.mjs";
import { documentSha256 } from "../scripts/plan-migrations.mjs";
import {
  BRIDGE_MIN_VERSION,
  parseBridgeArguments,
  planBridgeRollout,
  runBridgePlannerCommand,
  STRUCTURAL_PERMISSION_FIELDS,
} from "../scripts/plan-rollout-bridge.mjs";

function snapshotDocument(documentPath, fields, updateSuffix = "00") {
  return {
    id: documentPath.split("/").at(-1),
    path: documentPath,
    createTime: "2026-08-02T19:00:00.000Z",
    updateTime: `2026-08-02T20:00:${updateSuffix}.000Z`,
    fields: structuredClone(fields),
  };
}

function documentTarget(documentPath, fields, updateSuffix) {
  return {
    kind: "document",
    path: documentPath,
    document: fields === null
      ? null
      : snapshotDocument(documentPath, fields, updateSuffix),
  };
}

function collectionTarget(collectionPath, documents) {
  return {
    kind: "collection",
    path: collectionPath,
    documents,
  };
}

function bridgeSnapshot() {
  const approvedClan = snapshotDocument("clans/clan-newer-test", {
    name: "Newer Test Clan",
    tag: "TST",
    leaderId: "player-one",
    members: [
      {
        userId: "player-one",
        name: "Player One",
        role: "leader",
        deviceId: "device-one",
      },
      {
        userId: "player-two",
        name: "Player Two",
        role: "member",
      },
    ],
    joinRequests: [],
    totalMMR: 1200,
    customClanField: "keep until rollback",
  }, "11");
  const otherClan = snapshotDocument("clans/clan-established", {
    name: "Established Clan",
    tag: "EST",
    leaderId: "player-established",
    members: [{
      userId: "player-established",
      role: "leader",
    }],
    totalMMR: 9000,
  }, "12");
  const directory = snapshotDocument("clans_directory/index", {
    clans: [
      {
        id: "clan-newer-test",
        name: "Newer Test Clan",
        customEntryField: "remove with approved entry",
      },
      {
        id: "clan-established",
        name: "Established Clan",
        customEntryField: "preserve",
      },
    ],
    generatedBy: "legacy-client",
  }, "13");
  const currentNotice = snapshotDocument("clan_notices/player-one", {
    type: "kicked",
    clanName: "Earlier Clan",
    message: "Unread notice",
  }, "14");

  return {
    schemaVersion: 1,
    mode: "read-only",
    project: "sample-project",
    database: "(default)",
    capturedAt: "2026-08-02T20:10:00.000Z",
    targets: {
      "events/current": documentTarget("events/current", {
        name: "Sanitized Cup",
        startTime: 1000,
        endTime: 9000,
        maxMembers: 5,
        useClanReservations: true,
        perms: {
          allowJoin: true,
          allowKick: true,
          allowTagStyle: true,
        },
        eventNote: "preserve",
      }, "01"),
      clans: collectionTarget("clans", [approvedClan, otherClan]),
      clans_directory: collectionTarget("clans_directory", [directory]),
      clan_name_keys: collectionTarget("clan_name_keys", []),
      clan_tag_keys: collectionTarget("clan_tag_keys", []),
      clan_memberships: collectionTarget("clan_memberships", []),
      clan_devices: collectionTarget("clan_devices", []),
      clan_notices: collectionTarget("clan_notices", [currentNotice]),
      leaderboard: collectionTarget("leaderboard", [
        snapshotDocument("leaderboard/player-one_1v1", {
          sourceUserId: "player-one",
          playlist: "1v1",
          mmr: 1500,
        }, "15"),
      ]),
      "admin/blacklist": documentTarget("admin/blacklist", {
        minVersion: 11.7,
        deviceIds: ["blocked-device"],
        userIds: ["blocked-user"],
        notes: { "blocked-user": "keep this note" },
        customBlacklistField: true,
      }, "02"),
      "admin/migration": documentTarget("admin/migration", {
        allowLegacyClanWrites: false,
        startedBy: "release-owner",
      }, "03"),
    },
  };
}

function bridgeOptions(overrides = {}) {
  return {
    disbandClanId: "clan-newer-test",
    expectClanName: "Newer Test Clan",
    minVersion: BRIDGE_MIN_VERSION,
    ...overrides,
  };
}

function operationAt(plan, documentPath) {
  return plan.operations.find(operation => operation.path === documentPath);
}

test("bridge arguments are explicit, local-only, and offline by default", async () => {
  assert.deepEqual(parseBridgeArguments([]), { help: true });
  assert.deepEqual(parseBridgeArguments(["--help"]), { help: true });
  assert.throws(
    () => parseBridgeArguments(["--project", "sample-project"]),
    /local-only/,
  );
  assert.throws(
    () => parseBridgeArguments(["--deploy"]),
    /local-only/,
  );
  assert.throws(
    () => parseBridgeArguments(["--help", "--apply"]),
    /local-only/,
  );
  assert.throws(
    () => parseBridgeArguments([
      "--snapshot", "snapshot.json",
      "--disband-clan-id", "clan-newer-test",
      "--expect-clan-name", "Newer Test Clan",
      "--min-version", "16.0",
      "--output", "plan.json",
    ]),
    /exactly 16\.1/,
  );
  assert.throws(
    () => parseBridgeArguments([
      "--snapshot", "snapshot.json",
      "--disband-clan-id", "clan-newer-test",
      "--expect-clan-name", "Newer Test Clan",
      "--min-version", "16.10",
      "--output", "plan.json",
    ]),
    /exactly 16\.1/,
  );

  let reads = 0;
  let writes = 0;
  const dependencies = {
    readFileImpl: async () => {
      reads += 1;
      throw new Error("must not read");
    },
    writeFileImpl: async () => {
      writes += 1;
      throw new Error("must not write");
    },
  };
  assert.deepEqual(
    await runBridgePlannerCommand([], dependencies),
    { help: true, networkUsed: false },
  );
  assert.deepEqual(
    await runBridgePlannerCommand(["--help"], dependencies),
    { help: true, networkUsed: false },
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("bridge plan preserves fields and freezes only structural actions", () => {
  const snapshot = bridgeSnapshot();
  const plan = planBridgeRollout(snapshot, bridgeOptions());
  const migration = operationAt(plan, "admin/migration");
  const blacklist = operationAt(plan, "admin/blacklist");
  const event = operationAt(plan, "events/current");

  assert.deepEqual(migration.document, {
    allowLegacyClanWrites: true,
    startedBy: "release-owner",
  });
  assert.deepEqual(blacklist.document, {
    minVersion: 16.1,
    deviceIds: ["blocked-device"],
    userIds: ["blocked-user"],
    notes: { "blocked-user": "keep this note" },
    customBlacklistField: true,
  });
  assert.equal(event.document.name, "Sanitized Cup");
  assert.equal(event.document.startTime, 1000);
  assert.equal(event.document.endTime, 9000);
  assert.equal(event.document.maxMembers, 5);
  assert.equal(event.document.eventNote, "preserve");
  assert.equal(event.document.useClanReservations, false);
  for (const field of STRUCTURAL_PERMISSION_FIELDS) {
    assert.equal(event.document.perms[field], false, field);
  }
  assert.equal(event.document.perms.allowTagStyle, true);

  const missingMigrationSnapshot = bridgeSnapshot();
  missingMigrationSnapshot.targets["admin/migration"].document = null;
  const missingMigrationPlan = planBridgeRollout(
    missingMigrationSnapshot,
    bridgeOptions(),
  );
  assert.deepEqual(
    operationAt(missingMigrationPlan, "admin/migration").precondition,
    { exists: false },
  );
  assert.deepEqual(
    operationAt(missingMigrationPlan, "admin/migration").document,
    { allowLegacyClanWrites: true },
  );
  assert.deepEqual(
    missingMigrationPlan.rollbackValues["admin/migration"],
    { exists: false },
  );
});

test("bridge plan disbands one clan with exact snapshot preconditions", () => {
  const snapshot = bridgeSnapshot();
  const plan = planBridgeRollout(snapshot, bridgeOptions());
  const paths = plan.operations.map(operation => operation.path);
  const existingByPath = new Map([
    ...Object.values(snapshot.targets)
      .flatMap(target => target.kind === "document"
        ? [target.document]
        : target.documents)
      .filter(Boolean)
      .map(document => [document.path, document]),
  ]);

  assert.ok(plan.operations.every(operation => operation.destructive));
  assert.ok(plan.operations.every(operation =>
    operation.requiresExplicitApproval));
  for (const operation of plan.operations) {
    const current = existingByPath.get(operation.path);
    if (!current) {
      assert.deepEqual(operation.precondition, { exists: false });
      continue;
    }
    assert.deepEqual(operation.precondition, {
      exists: true,
      sha256: documentSha256(current.fields),
      updateTime: current.updateTime,
    });
  }

  const directory = operationAt(plan, "clans_directory/index");
  assert.equal(directory.action, "set");
  assert.equal(directory.document.generatedBy, "legacy-client");
  assert.deepEqual(directory.document.clans, [{
    id: "clan-established",
    name: "Established Clan",
    customEntryField: "preserve",
  }]);
  assert.equal(
    plan.operations.filter(operation =>
      operation.action === "delete"
      && operation.path.startsWith("clans/")).length,
    1,
  );
  assert.equal(
    operationAt(plan, "clans/clan-newer-test").action,
    "delete",
  );
  assert.equal(paths.includes("clans/clan-established"), false);
  assert.equal(paths.some(documentPath =>
    documentPath.startsWith("leaderboard/")), false);
  assert.equal(paths.some(documentPath =>
    documentPath.startsWith("clan_name_keys/")
    || documentPath.startsWith("clan_tag_keys/")
    || documentPath.startsWith("clan_memberships/")
    || documentPath.startsWith("clan_devices/")), false);
});

test("bridge notices use exact current or missing preconditions", () => {
  const snapshot = bridgeSnapshot();
  const plan = planBridgeRollout(snapshot, bridgeOptions());
  const existing = operationAt(plan, "clan_notices/player-one");
  const missing = operationAt(plan, "clan_notices/player-two");

  assert.deepEqual(existing.precondition, {
    exists: true,
    sha256: documentSha256(
      snapshot.targets.clan_notices.documents[0].fields,
    ),
    updateTime:
      snapshot.targets.clan_notices.documents[0].updateTime,
  });
  assert.deepEqual(missing.precondition, { exists: false });
  for (const operation of [existing, missing]) {
    assert.deepEqual(operation.document, {
      type: "admin_disbanded",
      clanId: "clan-newer-test",
      clanName: "Newer Test Clan",
      message: "The clan was disbanded.",
      at: snapshot.capturedAt,
    });
  }
  assert.equal(plan.summary.notices, 2);
});

test("bridge plan records complete rollback values and summary", () => {
  const snapshot = bridgeSnapshot();
  const plan = planBridgeRollout(snapshot, bridgeOptions());

  for (const documentPath of [
    "admin/migration",
    "admin/blacklist",
    "events/current",
    "clans/clan-newer-test",
    "clans_directory/index",
    "clan_notices/player-one",
  ]) {
    const current = documentPath === "clans/clan-newer-test"
      ? snapshot.targets.clans.documents[0]
      : documentPath === "clans_directory/index"
        ? snapshot.targets.clans_directory.documents[0]
        : documentPath === "clan_notices/player-one"
          ? snapshot.targets.clan_notices.documents[0]
          : snapshot.targets[documentPath].document;
    assert.deepEqual(
      plan.rollbackValues[documentPath].document,
      current.fields,
    );
    assert.deepEqual(
      plan.rollbackValues[documentPath].precondition,
      {
        exists: true,
        sha256: documentSha256(current.fields),
        updateTime: current.updateTime,
      },
    );
  }
  assert.deepEqual(
    plan.rollbackValues["clan_notices/player-two"],
    { exists: false },
  );
  assert.equal(plan.summary.clansDeleted, 1);
  assert.equal(plan.summary.directoryEntriesRemoved, 1);
  assert.equal(plan.summary.leaderboardOperations, 0);
  assert.equal(plan.summary.otherClanOperations, 0);
  assert.match(plan.summary.message, /other clans are untouched/);
  assert.deepEqual(
    plan.approval.operationIds,
    plan.operations.map(operation => operation.id),
  );
});

test("bridge planner refuses unsafe or stale clan state", async t => {
  await t.test("expected name mismatch", () => {
    assert.throws(
      () => planBridgeRollout(
        bridgeSnapshot(),
        bridgeOptions({ expectClanName: "Wrong Name" }),
      ),
      /does not match/,
    );
  });

  await t.test("missing clan", () => {
    const snapshot = bridgeSnapshot();
    snapshot.targets.clans.documents.shift();
    assert.throws(
      () => planBridgeRollout(snapshot, bridgeOptions()),
      /clans\/clan-newer-test is missing/,
    );
  });

  await t.test("directory does not contain clan exactly once", () => {
    const snapshot = bridgeSnapshot();
    snapshot.targets.clans_directory.documents[0].fields.clans.push(
      structuredClone(
        snapshot.targets.clans_directory.documents[0].fields.clans[0],
      ),
    );
    assert.throws(
      () => planBridgeRollout(snapshot, bridgeOptions()),
      /exactly once/,
    );
  });

  await t.test("member identity is missing", () => {
    const snapshot = bridgeSnapshot();
    delete snapshot.targets.clans.documents[0].fields.members[0].userId;
    assert.throws(
      () => planBridgeRollout(snapshot, bridgeOptions()),
      /explicit userId/,
    );
  });

  await t.test("reservation lock already exists", () => {
    const snapshot = bridgeSnapshot();
    snapshot.targets.clan_memberships.documents.push(
      snapshotDocument("clan_memberships/player-one", {
        clanId: "clan-newer-test",
        role: "leader",
      }, "16"),
    );
    assert.throws(
      () => planBridgeRollout(snapshot, bridgeOptions()),
      /full admin cleanup path/,
    );
  });
});

test("bridge command reads one local snapshot and never overwrites output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-bridge-"));
  const snapshotPath = path.join(directory, "snapshot.json");
  const outputPath = path.join(directory, "plan.json");
  await writeFile(
    snapshotPath,
    `${JSON.stringify(bridgeSnapshot(), null, 2)}\n`,
  );
  let reads = 0;
  let writes = 0;
  try {
    const result = await runBridgePlannerCommand([
      "--snapshot", snapshotPath,
      "--disband-clan-id", "clan-newer-test",
      "--expect-clan-name", "Newer Test Clan",
      "--min-version", "16.1",
      "--output", outputPath,
    ], {
      readFileImpl: async (...args) => {
        reads += 1;
        return readFile(...args);
      },
      writeFileImpl: async (...args) => {
        writes += 1;
        return writeFile(...args);
      },
    });
    assert.equal(result.networkUsed, false);
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.equal(
      JSON.parse(await readFile(outputPath, "utf8")).schemaVersion,
      2,
    );
    await assert.rejects(
      runBridgePlannerCommand([
        "--snapshot", snapshotPath,
        "--disband-clan-id", "clan-newer-test",
        "--expect-clan-name", "Newer Test Clan",
        "--min-version", "16.1",
        "--output", outputPath,
      ]),
      error => error?.code === "EEXIST",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply accepts the bridge only with exact hash and operation approvals", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "atlas-bridge-approval-"),
  );
  try {
    const plan = planBridgeRollout(bridgeSnapshot(), bridgeOptions());
    const planPath = path.join(directory, "plan.json");
    const planText = `${JSON.stringify(plan, null, 2)}\n`;
    const planSha256 = createHash("sha256").update(planText).digest("hex");
    await writeFile(planPath, planText);

    const approvalsPath = path.join(directory, "approvals.json");
    const writeApprovals = approvedOperationIds => writeFile(
      approvalsPath,
      `${JSON.stringify({
        schemaVersion: 1,
        project: "sample-project",
        planSha256,
        approvedOperationIds,
        conflictResolutions: [],
      }, null, 2)}\n`,
    );
    const options = {
      help: false,
      apply: true,
      plan: planPath,
      project: "sample-project",
      confirmProject: "sample-project",
      approvedPlanSha256: planSha256,
      approvals: approvalsPath,
      batchSize: 20,
    };

    await writeApprovals([]);
    await assert.rejects(
      prepareMigration(options),
      /explicit approval/,
    );
    await writeApprovals(plan.approval.operationIds);
    await assert.rejects(
      prepareMigration({ ...options, approvedPlanSha256: "0".repeat(64) }),
      /does not match/,
    );
    const prepared = await prepareMigration(options);
    assert.equal(prepared.operations.length, plan.operations.length);
    assert.deepEqual(
      prepared.operations.map(operation => operation.id),
      plan.approval.operationIds,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply allows only the exact bridge control paths", () => {
  const validPlan = planBridgeRollout(bridgeSnapshot(), bridgeOptions());
  assert.equal(
    selectApprovedOperations(validPlan, {}).length,
    validPlan.operations.length,
  );

  for (const documentPath of [
    "events/archive",
    "admin/clanPerms",
    "admin/other",
  ]) {
    const invalidPlan = structuredClone(validPlan);
    invalidPlan.operations[0].path = documentPath;
    assert.throws(
      () => selectApprovedOperations(invalidPlan, {}),
      /path is not allowed/,
    );
  }
});
