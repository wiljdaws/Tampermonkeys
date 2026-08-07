import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  after,
  before,
  beforeEach,
  test,
} from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  deleteDoc,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

import { planFixture } from "../scripts/plan-migrations.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const rulesPath = process.env.ATLAS_RULES_PATH;
if (!rulesPath) {
  console.log("Skipping integration-regressions: ATLAS_RULES_PATH not set");
  process.exit(0);
}
const rules = await readFile(path.resolve(rulesPath), "utf8");
const fixture = JSON.parse(await readFile(
  path.join(testDirectory, "fixtures", "atlas-contract.json"),
  "utf8",
));
const clanSitePath = process.env.CLAN_SITE_PATH
  ? path.resolve(process.env.CLAN_SITE_PATH)
  : path.resolve(workspace, "../../RG_Clan_leaderboard");
const { disbandClan } = await import(pathToFileURL(
  path.join(clanSitePath, "js/admin.js"),
));

let environment;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: "demo-rgleaderboard",
    firestore: { rules },
  });
});

after(async () => {
  await environment.cleanup();
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "admin", "blacklist"), {
      userIds: [],
      deviceIds: [],
      minVersion: 16,
    });
    await setDoc(doc(db, "admin", "migration"), {
      allowLegacyClanWrites: false,
    });
  });
});

function publicDb() {
  return environment.unauthenticatedContext().firestore();
}

function adminDb() {
  return environment.authenticatedContext("release-admin", {
    email: "therootedengineer@gmail.com",
  }).firestore();
}

function nameKey(name) {
  return createHash("sha256")
    .update(name.trim().replace(/\s+/g, " ").toLowerCase())
    .digest("hex");
}

function strictClan({
  name,
  tag,
  userId,
  deviceId,
}) {
  return {
    name,
    normalizedName: name.trim().replace(/\s+/g, " ").toLowerCase(),
    nameKey: nameKey(name),
    tag,
    tagKey: tag,
    leaderId: userId,
    deviceId,
    lockVersion: 1,
    versionNum: 16,
    members: {
      [userId]: {
        userId,
        name: userId,
        role: "leader",
        mmr: 1000,
        deviceIds: [deviceId],
      },
    },
    memberStats: {
      [userId]: {
        mmr: 1000,
        syncedAt: 100,
        deviceIds: [deviceId],
      },
    },
    memberIds: [userId],
    deviceIds: [deviceId],
    joinRequests: [],
    totalMMR: 1000,
  };
}

function directoryEntry(clanId, clan) {
  return {
    clanId,
    name: clan.name,
    tag: clan.tag,
    leaderId: clan.leaderId,
    memberCount: clan.memberIds.length,
    memberIds: clan.memberIds,
    deviceIds: clan.deviceIds,
    totalMMR: clan.totalMMR,
  };
}

async function createStrictClan(db, clanId, clan) {
  await runTransaction(db, async transaction => {
    transaction.set(doc(db, "clans", clanId), clan);
    transaction.set(
      doc(db, "clans_directory", clanId),
      directoryEntry(clanId, clan),
    );
    transaction.set(doc(db, "clan_name_keys", clan.nameKey), {
      clanId,
      name: clan.name,
      normalizedName: clan.normalizedName,
    });
    transaction.set(doc(db, "clan_tag_keys", clan.tagKey), {
      clanId,
      tag: clan.tag,
    });
    transaction.set(doc(db, "clan_memberships", clan.leaderId), {
      clanId,
      role: "leader",
      deviceIds: clan.deviceIds,
    });
    transaction.set(doc(db, "clan_devices", clan.deviceId), {
      clanId,
      userId: clan.leaderId,
    });
  });
}

async function seedPlanOutput() {
  const plan = planFixture({ clans: [fixture.clans.legacy] });
  assert.equal(plan.blockers.length, 0);
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const operation of plan.operations) {
      if (operation.action === "set") {
        await setDoc(
          doc(db, ...operation.path.split("/")),
          operation.document,
        );
      }
    }
  });
  return plan.clans.clanWrites[0].document;
}

test("migration output can be updated by the final client contract", async () => {
  const migrated = await seedPlanOutput();
  const db = publicDb();
  const clanRef = doc(db, "clans", "clan-contract");
  const shardRef = doc(db, "clans_directory", "clan-contract");
  const next = structuredClone(migrated);
  next.members["player-alpha"].mmr = 1275;
  next.members["player-alpha"].syncedAt = 300;
  next.memberStats["player-alpha"].mmr = 1275;
  next.memberStats["player-alpha"].syncedAt = 300;
  next.totalMMR = 2175;

  await assertSucceeds(runTransaction(db, async transaction => {
    transaction.set(clanRef, next);
    transaction.set(shardRef, directoryEntry("clan-contract", next));
  }));
  assert.equal((await getDoc(clanRef)).data().totalMMR, 2175);
});

test("device in clan but missing directory and lock is repairable", async () => {
  const migrated = await seedPlanOutput();
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "clans_directory", "clan-contract"), {
      ...directoryEntry("clan-contract", migrated),
      deviceIds: ["device-bravo", "device-bravo-alt"],
    });
  });
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await deleteDoc(doc(db, "clan_devices", "device-alpha"));
  });

  const db = publicDb();
  await assertSucceeds(runTransaction(db, async transaction => {
    const clanRef = doc(db, "clans", "clan-contract");
    const clanSnapshot = await transaction.get(clanRef);
    const clan = clanSnapshot.data();
    transaction.set(clanRef, {
      ...clan,
      lastReservationRepairAt: serverTimestamp(),
    });
    transaction.set(
      doc(db, "clans_directory", "clan-contract"),
      directoryEntry("clan-contract", clan),
    );
    transaction.set(doc(db, "clan_memberships", "player-alpha"), {
      clanId: "clan-contract",
      role: "leader",
      deviceIds: ["device-alpha"],
    });
    transaction.set(doc(db, "clan_devices", "device-alpha"), {
      clanId: "clan-contract",
      userId: "player-alpha",
    });
  }));
  assert.equal(
    (await getDoc(doc(db, "clan_devices", "device-alpha"))).data().clanId,
    "clan-contract",
  );
});

test("concurrent strict creates reserve one shared device", async () => {
  const first = strictClan({
    clanId: "first",
    name: "First Clan",
    tag: "FST",
    userId: "player-first",
    deviceId: "shared-device",
  });
  const second = strictClan({
    clanId: "second",
    name: "Second Clan",
    tag: "SND",
    userId: "player-second",
    deviceId: "shared-device",
  });
  const results = await Promise.allSettled([
    createStrictClan(publicDb(), "first", first),
    createStrictClan(publicDb(), "second", second),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
});

async function requestJoin(db, clanId, request) {
  const clanRef = doc(db, "clans", clanId);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(clanRef);
    const clan = snapshot.data();
    if (clan.joinRequests.some(entry => entry.userId === request.userId)) return;
    transaction.set(clanRef, {
      ...clan,
      joinRequests: [...clan.joinRequests, request],
    });
  });
}

async function approve(db, clanId, userId) {
  const clanRef = doc(db, "clans", clanId);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(clanRef);
    const clan = snapshot.data();
    const request = clan.joinRequests.find(entry => entry.userId === userId);
    if (!request) return;
    const member = {
      userId,
      name: request.name,
      role: "member",
      mmr: 900,
      deviceIds: [request.deviceId],
    };
    const next = {
      ...clan,
      members: { ...clan.members, [userId]: member },
      memberStats: {
        ...clan.memberStats,
        [userId]: {
          mmr: 900,
          syncedAt: 100,
          deviceIds: [request.deviceId],
        },
      },
      memberIds: [...clan.memberIds, userId],
      deviceIds: [...clan.deviceIds, request.deviceId],
      joinRequests: clan.joinRequests.filter(entry => entry.userId !== userId),
      totalMMR: clan.totalMMR + 900,
    };
    transaction.set(clanRef, next);
    transaction.set(
      doc(db, "clans_directory", clanId),
      directoryEntry(clanId, next),
    );
    transaction.set(doc(db, "clan_memberships", userId), {
      clanId,
      role: "member",
      deviceIds: [request.deviceId],
    });
    transaction.set(doc(db, "clan_devices", request.deviceId), {
      clanId,
      userId,
    });
  });
}

test("concurrent join and approve transactions preserve both applicants", async () => {
  const clan = strictClan({
    clanId: "racing",
    name: "Racing Clan",
    tag: "RCE",
    userId: "leader",
    deviceId: "leader-device",
  });
  await createStrictClan(publicDb(), "racing", clan);
  const requests = [
    { userId: "player-two", name: "Two", deviceId: "device-two" },
    { userId: "player-three", name: "Three", deviceId: "device-three" },
  ];
  await Promise.all(requests.map(request =>
    requestJoin(publicDb(), "racing", request)));
  await Promise.all(requests.map(request =>
    approve(publicDb(), "racing", request.userId)));

  const saved = (await getDoc(doc(publicDb(), "clans", "racing"))).data();
  assert.deepEqual(
    saved.memberIds.slice().sort(),
    ["leader", "player-three", "player-two"],
  );
  assert.equal(saved.joinRequests.length, 0);
});

test("cutover rejects legacy overwrites and mixed client versions", async () => {
  const clan = strictClan({
    clanId: "cutover",
    name: "Cutover Clan",
    tag: "CUT",
    userId: "leader",
    deviceId: "leader-device",
  });
  const db = publicDb();
  await createStrictClan(db, "cutover", clan);
  await assertFails(setDoc(doc(db, "clans", "cutover"), {
    ...clan,
    versionNum: 15.9,
  }));
  await assertFails(setDoc(doc(db, "clans", "cutover"), {
    name: clan.name,
    tag: clan.tag,
    leaderId: clan.leaderId,
    deviceId: clan.deviceId,
    versionNum: 16,
    members: Object.values(clan.members),
    joinRequests: [],
  }));
});

test("rollback compatibility allows only an explicitly enabled legacy shape", async () => {
  const legacy = {
    name: "Rollback Clan",
    tag: "RBK",
    leaderId: "legacy-leader",
    deviceId: "legacy-device",
    versionNum: 16,
    members: [{ userId: "legacy-leader", role: "leader" }],
    joinRequests: [],
  };
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "clans", "rollback"), legacy);
    await setDoc(doc(db, "admin", "migration"), {
      allowLegacyClanWrites: true,
    });
  });
  const db = publicDb();
  await assertSucceeds(setDoc(
    doc(db, "clans", "rollback"),
    { ...legacy, totalMMR: 1000 },
  ));
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "admin", "migration"), {
      allowLegacyClanWrites: false,
    });
  });
  await assertFails(setDoc(
    doc(db, "clans", "rollback"),
    { ...legacy, totalMMR: 1100 },
  ));
});

test("production clan admin helper satisfies final disband rules", async () => {
  const migrated = await seedPlanOutput();
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "clans_directory", "index"), {
      clans: [{ id: "clan-contract" }, { id: "other-clan" }],
    });
  });
  const db = adminDb();
  const result = await disbandClan({
    fb: { db, doc, runTransaction },
    clanId: "clan-contract",
    message: fixture.notices.adminDisband.message,
    now: fixture.notices.adminDisband.at,
    noticeType: fixture.notices.adminDisband.type,
    releaseReservations: true,
  });
  assert.equal(result.notified, migrated.memberIds.length);
  for (const pathname of [
    ["clans", "clan-contract"],
    ["clans_directory", "clan-contract"],
    ["clan_memberships", "player-alpha"],
    ["clan_memberships", "player-bravo"],
    ["clan_devices", "device-alpha"],
    ["clan_devices", "device-bravo"],
    ["clan_devices", "device-bravo-alt"],
  ]) {
    assert.equal((await getDoc(doc(db, ...pathname))).exists(), false);
  }
  assert.equal(
    (await getDoc(doc(db, "clan_notices", "player-alpha"))).data().type,
    "kicked",
  );
});
