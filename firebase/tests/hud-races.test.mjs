import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  after,
  before,
  beforeEach,
  test,
} from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const rulesPath = process.env.ATLAS_RULES_PATH;
if (!rulesPath) {
  console.log("Skipping hud-races: ATLAS_RULES_PATH not set");
  process.exit(0);
}
const rules = await readFile(path.resolve(rulesPath), "utf8");
const hudScriptPath = process.env.HUD_SCRIPT
  ? path.resolve(process.env.HUD_SCRIPT)
  : path.resolve(workspace, "../rg_hud.user.js");
const hudSource = await readFile(hudScriptPath, "utf8");

function extractHudFunction(name, context = {}) {
  const start = hudSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in HUD`);
  const signatureStart = hudSource.indexOf("(", start);
  let signatureDepth = 0;
  let signatureEnd = -1;
  for (let index = signatureStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "(") signatureDepth += 1;
    if (hudSource[index] === ")") signatureDepth -= 1;
    if (signatureDepth === 0) {
      signatureEnd = index;
      break;
    }
  }
  const bodyStart = hudSource.indexOf("{", signatureEnd);
  let depth = 0;
  for (let index = bodyStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "{") depth += 1;
    if (hudSource[index] === "}") depth -= 1;
    if (depth === 0) {
      return vm.runInNewContext(
        `(${hudSource.slice(start, index + 1)})`,
        context,
      );
    }
  }
  throw new Error(`unterminated ${name}`);
}

const alphaHex = extractHudFunction("alphaHex");
const tokenize = extractHudFunction("tokenize");
const isAsciiArtText = extractHudFunction("isAsciiArtText");
const preserveForgeNewlines = extractHudFunction("preserveForgeNewlines");
const wrapAsciiMonospace = extractHudFunction("wrapAsciiMonospace");
const artLineStats = extractHudFunction("artLineStats");
const artFitSizePct = extractHudFunction("artFitSizePct");
const artLineHeightPct = extractHudFunction("artLineHeightPct");
const artMspaceEm = extractHudFunction("artMspaceEm");
const artLineHeightEm = extractHudFunction("artLineHeightEm", { artMspaceEm });
const brailleToAsciiArt = extractHudFunction("brailleToAsciiArt");
const restorePreferredArtChars = extractHudFunction("restorePreferredArtChars");
const gameSafeArtChars = extractHudFunction("gameSafeArtChars", {
  restorePreferredArtChars,
});
const artPreviewText = extractHudFunction("artPreviewText", {
  restorePreferredArtChars,
  brailleToAsciiArt,
});
const packAsciiArt = extractHudFunction("packAsciiArt", {
  preserveForgeNewlines,
  artLineStats,
  artFitSizePct,
  artLineHeightPct,
  artMspaceEm,
  artLineHeightEm,
  brailleToAsciiArt,
  gameSafeArtChars,
});
const colorizeText = extractHudFunction("colorizeText", {
  alphaHex,
  tokenize,
  preserveForgeNewlines,
});
const resolveTitleColorStyle = extractHudFunction("resolveTitleColorStyle");
const captureForgeScroll = extractHudFunction("captureForgeScroll");
const restoreForgeScroll = extractHudFunction("restoreForgeScroll");
const nameForgeHistoryKey = extractHudFunction("nameForgeHistoryKey");
const updatedRecentHistory = extractHudFunction("updatedRecentHistory");
const scoredSuffix = extractHudFunction("scoredSuffix");
const splitRawScoredSuffix = extractHudFunction("splitRawScoredSuffix");
const hudEditableTextFromRaw = extractHudFunction("editableTextFromRaw");
const hudEditableFieldsFromRaw = extractHudFunction("editableFieldsFromRaw", {
  editableTextFromRaw: hudEditableTextFromRaw,
  isAsciiArtText,
});
const rawSnapshotFields = extractHudFunction("rawSnapshotFields", {
  editableFieldsFromRaw: hudEditableFieldsFromRaw,
  splitRawScoredSuffix,
});
const editableGlyphs = extractHudFunction("editableGlyphs");
const replaceRawVisibleText = extractHudFunction("replaceRawVisibleText", {
  editableGlyphs,
});
const replaceRawTitleText = extractHudFunction("replaceRawTitleText", {
  editableTextFromRaw: hudEditableTextFromRaw,
  replaceRawVisibleText,
});
const buildCode = extractHudFunction("buildCode", {
  alphaHex,
  colorizeText,
  resolveTitleColorStyle,
  scoredSuffix,
  isAsciiArtText,
  wrapAsciiMonospace,
  packAsciiArt,
  brailleToAsciiArt,
  restorePreferredArtChars,
  gameSafeArtChars,
});
const effectiveForgeCode = extractHudFunction("effectiveForgeCode", {
  buildCode,
  scoredSuffix,
  preserveForgeNewlines,
  isAsciiArtText,
  wrapAsciiMonospace,
  packAsciiArt,
});
const clanMembers = extractHudFunction("clanMembers");
const clanMembersField = extractHudFunction("clanMembersField", {
  clanMembers,
});
const effectiveClanMemberStat = extractHudFunction("effectiveClanMemberStat", {
  clanMembers,
});
const effectiveClanTotalMMR = extractHudFunction("effectiveClanTotalMMR", {
  clanMembers,
  effectiveClanMemberStat,
});
const normalizeClanName = extractHudFunction("normalizeClanName");
const clanMemberDeviceIds = extractHudFunction("clanMemberDeviceIds", {
  clanMembers,
});
const clanHasDeviceId = extractHudFunction("clanHasDeviceId", {
  clanMembers,
});
const clanDeviceLinkPlan = extractHudFunction("clanDeviceLinkPlan", {
  clanHasDeviceId,
});
const clanMembershipRecord = extractHudFunction("clanMembershipRecord");
const canonicalClanDirectory = extractHudFunction("canonicalClanDirectory");
const findDirectoryMembership = extractHudFunction("findDirectoryMembership", {
  canonicalClanDirectory,
});
const putClanInDirectory = extractHudFunction("putClanInDirectory", {
  canonicalClanDirectory,
});
const clanMMRWriteFields = extractHudFunction("clanMMRWriteFields", {
  clanMembers,
  clanMembersField,
  effectiveClanTotalMMR,
});

test("matchEnd directly schedules a forced clan score sync", () => {
  const start = hudSource.indexOf(
    'if (url.includes("/v0304_player/matchEnd"))',
  );
  const end = hudSource.indexOf(
    '} else if (url.includes("/v0304_login/login"))',
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(
    hudSource.slice(start, end),
    /syncClanAfterMatch\(lastKnownPlayerData\)/,
  );
});

test("clan reservation helpers normalize names and keep every device", () => {
  assert.equal(normalizeClanName("  Alpha   Omega "), "alpha omega");
  const clan = {
    members: [{
      userId: "player-a",
      deviceId: "device-a",
      deviceIds: ["device-b"],
    }],
    memberStats: {
      "player-a": {
        deviceIds: ["device-b", "device-c"],
      },
    },
  };
  assert.deepEqual(
    [...clanMemberDeviceIds(clan, "player-a")],
    ["device-a", "device-b", "device-c"],
  );
  const membership = clanMembershipRecord(
    "clan-one",
    "leader",
    ["device-a", "device-a", "device-b"],
  );
  assert.equal(membership.clanId, "clan-one");
  assert.equal(membership.role, "leader");
  assert.deepEqual([...membership.deviceIds], ["device-a", "device-b"]);
});

test("clan member compatibility preserves arrays and maps", () => {
  const legacy = {
    members: [
      { userId: "leader", name: "Leader", role: "leader" },
      { userId: "racer", name: "Racer", role: "member" },
    ],
  };
  assert.deepEqual(
    clanMembers(legacy).map((member) => member.userId),
    ["leader", "racer"],
  );
  assert.ok(Array.isArray(clanMembersField(legacy, clanMembers(legacy)).members));

  const mapped = {
    members: {
      leader: { name: "Leader", role: "leader" },
      racer: { userId: "racer", name: "Racer", role: "member" },
    },
  };
  assert.deepEqual(
    [...clanMembers(mapped)].map((member) => member.userId).sort(),
    ["leader", "racer"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(clanMembersField(mapped, [
      { userId: "leader", role: "coleader" },
      { userId: "racer", role: "leader" },
    ]).members)),
    {
      leader: { userId: "leader", role: "coleader", deviceIds: [] },
      racer: { userId: "racer", role: "leader", deviceIds: [] },
    },
  );
});

test("repairs the split device state without rewriting the roster", () => {
  const clan = {
    id: "clan-one",
    members: [{
      userId: "player-one",
      deviceId: "device-one",
      name: "Player",
      role: "member",
    }],
  };

  const legacyPlan = clanDeviceLinkPlan({
    clan,
    uid: "player-one",
    deviceId: "device-one",
    directoryEntry: {
      id: "clan-one",
      memberIds: ["player-one"],
      deviceIds: [],
    },
    useReservations: false,
  });
  assert.deepEqual(
    {
      conflictClanId: legacyPlan.conflictClanId,
      repairClan: legacyPlan.repairClan,
      repairPointer: legacyPlan.repairPointer,
    },
    { conflictClanId: null, repairClan: false, repairPointer: true },
  );

  const reservationPlan = clanDeviceLinkPlan({
    clan,
    uid: "player-one",
    deviceId: "device-one",
    membership: { clanId: "clan-one" },
    device: null,
    useReservations: true,
  });
  assert.deepEqual(
    {
      conflictClanId: reservationPlan.conflictClanId,
      repairClan: reservationPlan.repairClan,
      repairPointer: reservationPlan.repairPointer,
    },
    { conflictClanId: null, repairClan: false, repairPointer: true },
  );
  assert.equal(clanDeviceLinkPlan({
    clan,
    uid: "player-one",
    deviceId: "device-one",
    membership: { clanId: "clan-one" },
    device: { clanId: "clan-one", userId: "other-player" },
    useReservations: true,
  }).conflictClanId, "clan-one");
  assert.equal(clanDeviceLinkPlan({
    clan,
    uid: "player-one",
    deviceId: "device-one",
    membership: { clanId: "clan-one" },
    device: { clanId: "clan-one", userId: "player-one" },
    directoryEntry: {
      id: "clan-one",
      memberIds: ["player-one"],
      deviceIds: [],
    },
    useReservations: true,
  }).repairPointer, true);

  const start = hudSource.indexOf(
    "async function linkCurrentClanDevice(fb, clan, uid, deviceId)",
  );
  const end = hudSource.indexOf(
    "// Legacy mode rebuilds",
    start,
  );
  const source = hudSource.slice(start, end);
  assert.match(source, /const plan = clanDeviceLinkPlan\(/);
  assert.match(source, /if \(!plan\.repairClan && !plan\.repairPointer\)/);
  assert.match(source, /lastReservationRepairAt:\s*fb\.serverTimestamp\(\)/);
  assert.match(source, /tx\.set\(\s*membershipRef/);
  assert.match(source, /tx\.set\(deviceRef/);
});

test("reservation path uses point locks and directory shards", () => {
  assert.match(
    hudSource,
    /fb\.doc\(fb\.db,\s*"clan_memberships",\s*uid\)/,
  );
  assert.match(
    hudSource,
    /fb\.doc\(fb\.db,\s*"clan_devices",\s*deviceId\)/,
  );
  assert.match(
    hudSource,
    /fb\.doc\(fb\.db,\s*"clans_directory",\s*clanId\)/,
  );

  const refreshStart = hudSource.indexOf("async function refreshDirectory(fb)");
  const refreshEnd = hudSource.indexOf(
    "// sum of 3v3+2v2+1v1",
    refreshStart,
  );
  const refreshSource = hudSource.slice(refreshStart, refreshEnd);
  assert.match(refreshSource, /loadClanDirectoryLite\(/);
  assert.match(refreshSource, /firestoreReadBudgetPassed\(/);
  assert.doesNotMatch(refreshSource, /getDocs\(/);
  assert.doesNotMatch(
    hudSource,
    /getDocs\(\s*fb\.collection\(\s*fb\.db,\s*"clans(?:_directory)?"\s*\)/,
  );
});

test("new clan mutations keep score and structure in transactions", () => {
  const mutationNames = [
    "updateMyClanMMR",
    "createClan",
    "requestJoin",
    "approveRequest",
    "kickMember",
    "setMemberRole",
    "editClan",
    "transferLeadership",
    "leaveClan",
  ];
  for (const name of mutationNames) {
    const start = hudSource.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const next = hudSource.indexOf("\n    async function ", start + 1);
    const source = hudSource.slice(start, next < 0 ? undefined : next);
    assert.match(source, /runAtlasTransaction\(/, `${name} is not atomic`);
  }
});

test("leadership, leave, and notices use the safe paths", () => {
  const transferStart = hudSource.indexOf(
    "async function transferLeadership(userId)",
  );
  const transferEnd = hudSource.indexOf(
    "// ---------- Clan tag styling ----------",
    transferStart,
  );
  assert.match(
    hudSource.slice(transferStart, transferEnd),
    /oldLeaderRef,[\s\S]*clanMembershipRecord\([\s\S]*"coleader"/,
  );

  const leaveStart = hudSource.indexOf("async function leaveClan()");
  const leaveEnd = hudSource.indexOf(
    "// ---------- Clan view rendering ----------",
    leaveStart,
  );
  assert.match(hudSource.slice(leaveStart, leaveEnd), /tx\.delete\(membershipRef\)/);

  const noticeStart = hudSource.indexOf("async function checkClanNotices()");
  const noticeEnd = hudSource.indexOf(
    "// ---------- Role management ----------",
    noticeStart,
  );
  const noticeSource = hudSource.slice(noticeStart, noticeEnd);
  assert.match(noticeSource, /n\.type === "admin_disbanded"/);
  assert.match(noticeSource, /await showDialog/);
  assert.match(
    noticeSource,
    /await atlasDeleteDoc\(fb,\s*"acknowledge clan notice",\s*ref\)/,
  );
});

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
});

function publicDb(userId) {
  return environment.authenticatedContext(userId, {
    email: "therootedengineer@gmail.com",
  }).firestore();
}

async function seedClan() {
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "clans", "clan-one"), {
      name: "Clan One",
      tag: "ONE",
      leaderId: "leader",
      members: [
        { userId: "leader", name: "Leader", role: "leader", mmr: 4000 },
        { userId: "racer", name: "Racer", role: "member", mmr: 3000 },
      ],
      joinRequests: [{ userId: "applicant", name: "Applicant" }],
      totalMMR: 7000,
    });
  });
}

function directoryEntry(id, name, tag, memberIds = [], deviceIds = []) {
  return {
    id,
    name,
    tag,
    memberCount: memberIds.length,
    memberIds,
    deviceIds,
    totalMMR: 0,
  };
}

test("split reservation state repairs through the client rules", async () => {
  const nameKey = "a".repeat(64);
  const clan = {
    name: "Clan One",
    tag: "ONE",
    normalizedName: "clan one",
    nameKey,
    tagKey: "ONE",
    lockVersion: 1,
    leaderId: "player-one",
    deviceId: "device-one",
    members: {
      "player-one": {
        userId: "player-one",
        name: "Player",
        role: "leader",
        deviceIds: ["device-one"],
      },
    },
    memberIds: ["player-one"],
    deviceIds: ["device-one"],
    memberStats: {
      "player-one": { deviceIds: ["device-one"] },
    },
    joinRequests: [],
    versionNum: 16,
  };
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "clans", "clan-one"), clan);
    await setDoc(doc(db, "clan_name_keys", nameKey), {
      clanId: "clan-one",
      normalizedName: "clan one",
    });
    await setDoc(doc(db, "clan_tag_keys", "ONE"), {
      clanId: "clan-one",
      tag: "ONE",
    });
    await setDoc(doc(db, "clan_memberships", "player-one"), {
      clanId: "clan-one",
      role: "leader",
      deviceIds: ["device-one"],
    });
    await setDoc(doc(db, "clans_directory", "clan-one"), {
      clanId: "clan-one",
      name: "Clan One",
      tag: "ONE",
      leaderId: "player-one",
      memberCount: 1,
      memberIds: ["player-one"],
      deviceIds: [],
    });
  });

  const db = environment.unauthenticatedContext().firestore();
  const clanRef = doc(db, "clans", "clan-one");
  const directoryRef = doc(db, "clans_directory", "clan-one");
  const membershipRef = doc(db, "clan_memberships", "player-one");
  const deviceRef = doc(db, "clan_devices", "device-one");
  await runTransaction(db, async transaction => {
    await transaction.get(clanRef);
    await transaction.get(directoryRef);
    await transaction.get(membershipRef);
    await transaction.get(deviceRef);
    transaction.set(clanRef, {
      members: clan.members,
      memberStats: clan.memberStats,
      memberIds: clan.memberIds,
      deviceIds: clan.deviceIds,
      lastReservationRepairAt: serverTimestamp(),
    }, { merge: true });
    transaction.set(directoryRef, {
      clanId: "clan-one",
      name: "Clan One",
      tag: "ONE",
      leaderId: "player-one",
      memberCount: 1,
      memberIds: ["player-one"],
      deviceIds: ["device-one"],
    });
    transaction.set(membershipRef, {
      clanId: "clan-one",
      role: "leader",
      deviceIds: ["device-one"],
    });
    transaction.set(deviceRef, {
      clanId: "clan-one",
      userId: "player-one",
    });
  });

  assert.deepEqual(
    (await getDoc(directoryRef)).data().deviceIds,
    ["device-one"],
  );
  assert.equal((await getDoc(deviceRef)).data().userId, "player-one");
});

async function createClanWithMembershipGuard(db, clanId, identity) {
  const directoryRef = doc(db, "clans_directory", "index");
  const clanRef = doc(db, "clans", clanId);
  let outcome = "created";
  await runTransaction(db, async transaction => {
    const directorySnapshot = await transaction.get(directoryRef);
    const liveDirectory = directorySnapshot.exists()
      ? directorySnapshot.data().clans || []
      : [];
    if (findDirectoryMembership(liveDirectory, identity)) {
      outcome = "already-in-clan";
      return;
    }
    const clan = {
      name: `Clan ${clanId}`,
      tag: clanId.slice(0, 4).toUpperCase(),
      leaderId: identity.userId,
      members: [{
        userId: identity.userId,
        name: identity.userId,
        role: "leader",
        deviceId: identity.deviceId,
      }],
      joinRequests: [],
    };
    const nextDirectory = putClanInDirectory(
      liveDirectory,
      directoryEntry(
        clanId,
        clan.name,
        clan.tag,
        [identity.userId],
        [identity.deviceId],
      ),
    );
    transaction.set(clanRef, clan);
    transaction.set(directoryRef, {
      clans: JSON.parse(JSON.stringify(nextDirectory)),
    });
  });
  return outcome;
}

async function approveWithMembershipGuard(db, clanId, identity) {
  const directoryRef = doc(db, "clans_directory", "index");
  const clanRef = doc(db, "clans", clanId);
  let outcome = "approved";
  await runTransaction(db, async transaction => {
    const directorySnapshot = await transaction.get(directoryRef);
    const clanSnapshot = await transaction.get(clanRef);
    const liveDirectory = directorySnapshot.data().clans || [];
    if (findDirectoryMembership(liveDirectory, identity)) {
      outcome = "already-in-clan";
      return;
    }
    const clan = clanSnapshot.data();
    const members = [
      ...clan.members,
      {
        userId: identity.userId,
        name: identity.userId,
        role: "member",
        deviceId: identity.deviceId,
      },
    ];
    const nextDirectory = putClanInDirectory(
      liveDirectory,
      directoryEntry(
        clanId,
        clan.name,
        clan.tag,
        members.map(member => member.userId),
        members.map(member => member.deviceId).filter(Boolean),
      ),
    );
    transaction.set(clanRef, {
      members,
      joinRequests: [],
    }, { merge: true });
    transaction.set(directoryRef, {
      clans: JSON.parse(JSON.stringify(nextDirectory)),
    });
  });
  return outcome;
}

test("simultaneous clan creates allow only one account per device", async () => {
  const sharedDevice = "shared-atlas-device";
  const outcomes = await Promise.all([
    createClanWithMembershipGuard(publicDb("tab-one"), "first", {
      userId: "main-account",
      deviceId: sharedDevice,
    }),
    createClanWithMembershipGuard(publicDb("tab-two"), "second", {
      userId: "alternate-account",
      deviceId: sharedDevice,
    }),
  ]);
  assert.equal(outcomes.filter(value => value === "created").length, 1);
  assert.equal(
    outcomes.filter(value => value === "already-in-clan").length,
    1,
  );
  const db = publicDb("observer");
  const count =
    Number((await getDoc(doc(db, "clans", "first"))).exists())
    + Number((await getDoc(doc(db, "clans", "second"))).exists());
  assert.equal(count, 1);
});

test("simultaneous approvals cannot place one device in two clans", async () => {
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const [clanId, leaderId, deviceId] of [
      ["alpha", "alpha-leader", "alpha-device"],
      ["beta", "beta-leader", "beta-device"],
    ]) {
      await setDoc(doc(db, "clans", clanId), {
        name: clanId === "alpha" ? "Alpha" : "Beta",
        tag: clanId === "alpha" ? "AA" : "BB",
        leaderId,
        members: [{
          userId: leaderId,
          name: leaderId,
          role: "leader",
          deviceId,
        }],
        joinRequests: [{
          userId: "alternate-account",
          name: "Alternate",
          deviceId: "shared-atlas-device",
        }],
      });
    }
    await setDoc(doc(db, "clans_directory", "index"), {
      clans: [
        directoryEntry(
          "alpha",
          "Alpha",
          "AA",
          ["alpha-leader"],
          ["alpha-device"],
        ),
        directoryEntry(
          "beta",
          "Beta",
          "BB",
          ["beta-leader"],
          ["beta-device"],
        ),
      ],
    });
  });
  const identity = {
    userId: "alternate-account",
    deviceId: "shared-atlas-device",
  };
  const outcomes = await Promise.all([
    approveWithMembershipGuard(publicDb("alpha-leader"), "alpha", identity),
    approveWithMembershipGuard(publicDb("beta-leader"), "beta", identity),
  ]);
  assert.equal(outcomes.filter(value => value === "approved").length, 1);
  assert.equal(
    outcomes.filter(value => value === "already-in-clan").length,
    1,
  );
  const db = publicDb("observer");
  const rosters = await Promise.all([
    getDoc(doc(db, "clans", "alpha")),
    getDoc(doc(db, "clans", "beta")),
  ]);
  assert.equal(
    rosters.filter(snapshot => snapshot.data().members.some(
      member => member.userId === identity.userId,
    )).length,
    1,
  );
});

test("forced match-end clan sync preserves the roster", async () => {
  await seedClan();
  const db = publicDb("racer");
  const clanRef = doc(db, "clans", "clan-one");
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(clanRef);
    const fields = clanMMRWriteFields(
      snapshot.data(),
      "racer",
      3020,
      1785639500000,
    );
    transaction.set(
      clanRef,
      JSON.parse(JSON.stringify(fields)),
      { merge: true },
    );
  });
  const clan = (await getDoc(clanRef)).data();
  const racer = clan.members.find(member => member.userId === "racer");
  assert.equal(racer.mmr, 3020);
  assert.equal(clan.totalMMR, 7020);
  assert.ok(clan.members.some(member => member.userId === "leader"));
});

test("effective clan stats choose the newest representation", () => {
  const member = { userId: "racer", mmr: 3000, syncedAt: 100 };
  const mappedNewer = effectiveClanMemberStat({
    members: [member],
    memberStats: {
      racer: { mmr: 3020, syncedAt: 200 },
    },
  }, member);
  assert.equal(mappedNewer.mmr, 3020);
  const legacyNewer = effectiveClanMemberStat({
    members: [{ ...member, mmr: 3040, syncedAt: 300 }],
    memberStats: {
      racer: { mmr: 3020, syncedAt: 200 },
    },
  }, { ...member, mmr: 3040, syncedAt: 300 });
  assert.equal(legacyNewer.mmr, 3040);
});

test("memberStats survives a legacy teammate overwrite", async () => {
  await seedClan();
  const racerDb = publicDb("racer");
  const leaderDb = publicDb("leader");
  const racerRef = doc(racerDb, "clans", "clan-one");
  const leaderRef = doc(leaderDb, "clans", "clan-one");
  const legacySnapshot = await getDoc(leaderRef);
  const firstSyncAt = 1785639500000;

  await runTransaction(racerDb, async transaction => {
    const snapshot = await transaction.get(racerRef);
    const fields = clanMMRWriteFields(
      snapshot.data(),
      "racer",
      3020,
      firstSyncAt,
    );
    transaction.set(
      racerRef,
      JSON.parse(JSON.stringify(fields)),
      { merge: true },
    );
  });
  await setDoc(
    leaderRef,
    mmrUpdateFromSnapshot(legacySnapshot, "leader", 4030),
    { merge: true },
  );
  const clan = (await getDoc(racerRef)).data();
  const racer = clan.members.find(member => member.userId === "racer");
  assert.equal(racer.mmr, 3000);
  assert.equal(effectiveClanMemberStat(clan, racer).mmr, 3020);
  assert.equal(effectiveClanTotalMMR(clan), 7050);
});

test("clan MMR sync preserves every device linked to an account", () => {
  const fields = clanMMRWriteFields({
    members: [{
      userId: "racer",
      name: "Racer",
      role: "member",
      mmr: 3000,
      deviceId: "first-device",
    }],
    memberStats: {
      racer: {
        mmr: 3000,
        syncedAt: 100,
        deviceIds: ["first-device"],
      },
    },
  }, "racer", 3020, 200, "second-device");
  assert.equal(fields.members[0].deviceId, "second-device");
  assert.deepEqual(
    [...fields.memberStats.racer.deviceIds],
    ["first-device", "second-device"],
  );
});

test("clan MMR sync keeps mapped rosters mapped", () => {
  const fields = clanMMRWriteFields({
    members: {
      leader: {
        userId: "leader",
        name: "Leader",
        role: "leader",
        mmr: 4000,
      },
      racer: {
        userId: "racer",
        name: "Racer",
        role: "member",
        mmr: 3000,
      },
    },
    memberStats: {},
  }, "racer", 3020, 200, "racer-device");
  assert.equal(Array.isArray(fields.members), false);
  assert.equal(fields.members.racer.mmr, 3020);
  assert.equal(fields.members.leader.mmr, 4000);
  assert.equal(fields.totalMMR, 7020);
});

test("duplicate clan rows collapse and membership matches player or device", () => {
  const duplicateRows = [
    {
      id: "a-legacy",
      name: "[ ' _ ' ]",
      tag: "OG",
      totalMMR: 8454,
      createdAt: "2026-07-27T10:09:18.232Z",
      memberIds: ["leader"],
    },
    {
      id: "b-copy",
      name: " [  '  _  '  ] ",
      tag: "og",
      totalMMR: 8504,
      createdAt: "2026-07-27T10:09:17.151Z",
      memberIds: ["leader"],
    },
  ];
  assert.equal(canonicalClanDirectory(duplicateRows).length, 1);
  assert.equal(canonicalClanDirectory(duplicateRows)[0].id, "a-legacy");

  const directory = [{
    id: "clan-one",
    name: "Clan One",
    tag: "ONE",
    memberIds: ["main-account"],
    deviceIds: ["shared-device"],
  }];
  assert.equal(
    findDirectoryMembership(directory, {
      userId: "main-account",
      deviceId: "other-device",
    }).membershipMatch,
    "player",
  );
  assert.equal(
    findDirectoryMembership(directory, {
      userId: "alternate-account",
      deviceId: "shared-device",
    }).membershipMatch,
    "device",
  );
});

function mmrUpdateFromSnapshot(snapshot, userId, mmr) {
  const clan = snapshot.data();
  const members = clan.members.map(member =>
    member.userId === userId ? { ...member, mmr } : member);
  return {
    members,
    totalMMR: members.reduce((sum, member) => sum + (member.mmr || 0), 0),
  };
}

function approveFromSnapshot(snapshot, applicantId) {
  const clan = snapshot.data();
  const request = clan.joinRequests.find(entry => entry.userId === applicantId);
  return {
    joinRequests: clan.joinRequests.filter(
      entry => entry.userId !== applicantId,
    ),
    members: [
      ...clan.members,
      { userId: request.userId, name: request.name, role: "member" },
    ],
  };
}

test("reproduces the stale clan roster overwrite", async () => {
  await seedClan();
  const leaderDb = publicDb("leader");
  const racerDb = publicDb("racer");
  const leaderRef = doc(leaderDb, "clans", "clan-one");
  const racerRef = doc(racerDb, "clans", "clan-one");
  const leaderSnapshot = await getDoc(leaderRef);
  const staleRacerSnapshot = await getDoc(racerRef);
  await setDoc(
    leaderRef,
    approveFromSnapshot(leaderSnapshot, "applicant"),
    { merge: true },
  );
  await setDoc(
    racerRef,
    mmrUpdateFromSnapshot(staleRacerSnapshot, "racer", 3050),
    { merge: true },
  );
  const clan = (await getDoc(leaderRef)).data();
  assert.equal(
    clan.members.some(member => member.userId === "applicant"),
    false,
  );
});

test("transaction retry preserves an approved member during an MMR race", async () => {
  await seedClan();
  const leaderDb = publicDb("leader");
  const racerDb = publicDb("racer");
  const leaderRef = doc(leaderDb, "clans", "clan-one");
  const racerRef = doc(racerDb, "clans", "clan-one");
  let releaseFirstAttempt;
  const continueFirst = new Promise(resolve => {
    releaseFirstAttempt = resolve;
  });
  let firstReadComplete;
  const firstRead = new Promise(resolve => {
    firstReadComplete = resolve;
  });
  let attempts = 0;
  const write = runTransaction(racerDb, async transaction => {
    attempts += 1;
    const snapshot = await transaction.get(racerRef);
    if (attempts === 1) {
      firstReadComplete();
      await continueFirst;
    }
    transaction.set(
      racerRef,
      mmrUpdateFromSnapshot(snapshot, "racer", 3050),
      { merge: true },
    );
  });
  await firstRead;
  const leaderSnapshot = await getDoc(leaderRef);
  await setDoc(
    leaderRef,
    approveFromSnapshot(leaderSnapshot, "applicant"),
    { merge: true },
  );
  releaseFirstAttempt();
  await write;
  const clan = (await getDoc(leaderRef)).data();
  assert.ok(attempts >= 2);
  assert.ok(clan.members.some(member => member.userId === "applicant"));
});

async function requestJoin(db, userId, name) {
  const clanRef = doc(db, "clans", "clan-one");
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(clanRef);
    const requests = snapshot.data().joinRequests || [];
    if (requests.some(entry => entry.userId === userId)) return;
    transaction.set(
      clanRef,
      { joinRequests: [...requests, { userId, name }] },
      { merge: true },
    );
  });
}

async function approve(db, userId) {
  const clanRef = doc(db, "clans", "clan-one");
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(clanRef);
    const clan = snapshot.data();
    const request = clan.joinRequests.find(entry => entry.userId === userId);
    if (!request) return;
    transaction.set(
      clanRef,
      {
        joinRequests: clan.joinRequests.filter(
          entry => entry.userId !== userId,
        ),
        members: [
          ...clan.members,
          { userId, name: request.name, role: "member" },
        ],
      },
      { merge: true },
    );
  });
}

test("concurrent transactional joins and approvals preserve both players", async () => {
  await seedClan();
  await Promise.all([
    requestJoin(publicDb("two"), "applicant-two", "Applicant Two"),
    requestJoin(publicDb("three"), "applicant-three", "Applicant Three"),
  ]);
  let clan = (await getDoc(
    doc(publicDb("observer"), "clans", "clan-one"),
  )).data();
  assert.ok(clan.joinRequests.some(entry => entry.userId === "applicant-two"));
  assert.ok(clan.joinRequests.some(entry => entry.userId === "applicant-three"));

  await Promise.all([
    approve(publicDb("leader-one"), "applicant-two"),
    approve(publicDb("leader-two"), "applicant-three"),
  ]);
  clan = (await getDoc(
    doc(publicDb("observer-two"), "clans", "clan-one"),
  )).data();
  assert.ok(clan.members.some(member => member.userId === "applicant-two"));
  assert.ok(clan.members.some(member => member.userId === "applicant-three"));
});

test("Name Forge timing and color helpers keep expected behavior", () => {
  const desired = "<b>Stolen Name</b>";
  const events = [
    { at: 0, order: 0, name: desired },
    { at: 1500, order: 1, name: "Old Name" },
    { at: 4000, order: 2, name: desired },
  ];
  const final = events
    .slice()
    .sort((left, right) => left.at - right.at || left.order - right.order)
    .reduce((_name, event) => event.name, "Old Name");
  assert.equal(final, desired);
  assert.equal(
    colorizeText("AB", "solid", "#123456", [], true, 12, 80),
    "<#12345650><rotate=12>A<rotate=-12>B<rotate=0>",
  );
  const style = resolveTitleColorStyle({
    titleColorMode: "inherit",
    colorMode: "gradient",
    solidColor: "#123456",
    stops: ["#112233", "#445566", "#778899"],
    solidAlpha: 80,
  });
  assert.equal(style.mode, "gradient");
  assert.deepEqual([...style.stops], ["#112233", "#445566", "#778899"]);
});

test("raw Name Forge snapshots keep titles and Scored modifiers", () => {
  assert.deepEqual(
    { ...hudEditableFieldsFromRaw("<b>Player</b>\n<size=60%>Finalist") },
    {
      name: "Player",
      titleOn: true,
      titleText: "Finalist",
    },
  );
  const base = "<#4C67B5>SayoshiRG";
  for (const [suffix, mode] of [
    ["", "default"],
    ["<size=0>", "hide"],
    ["<sub><size=25%>", "tiny"],
  ]) {
    const state = rawSnapshotFields(base + suffix);
    assert.equal(state.rawCode, base);
    assert.equal(state.scoredMode, mode);
    assert.equal(effectiveForgeCode(state), base + suffix);
  }
});

test("Name Forge keeps ASCII art line breaks and spaces", () => {
  const art = " __\n/_/\\/\\\n\\_\\  /";
  assert.equal(isAsciiArtText(art), true);
  assert.equal(preserveForgeNewlines(art), " __<br>/_/\\/\\<br>\\_\\  /");
  const fields = hudEditableFieldsFromRaw(art);
  assert.equal(fields.name, art);
  assert.equal(fields.titleOn, false);
  const code = buildCode({
    name: art,
    colorMode: "none",
    solidColor: "#ffffff",
    stops: ["#ffffff", "#000000"],
    skipSpaces: true,
    waveOn: false,
    waveAmp: 0,
    rotateDeg: 0,
    sizePct: 100,
    markOn: false,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    titleOn: false,
    titleText: "",
    titleColorMode: "inherit",
    titleSizePct: 100,
    titleSub: false,
    titleBold: false,
    titleItalic: false,
    titleUnderline: false,
    titleStrike: false,
    scoredMode: "default",
  });
  assert.match(code, /<mspace=0\.6em>/);
  assert.match(code, / __<br>\/_\/\\\/\\<br>\\_\\  \//);
  assert.equal(
    effectiveForgeCode({ rawCode: art, name: art, scoredMode: "default" }),
    `<mspace=0.6em>${preserveForgeNewlines(art)}</mspace>`,
  );
});

test("title Inherit explicitly reuses the Name solid color", () => {
  const code = buildCode({
    name: "Player",
    colorMode: "solid",
    solidColor: "#123456",
    solidAlpha: 80,
    stops: ["#123456", "#654321"],
    skipSpaces: true,
    waveOn: false,
    waveAmp: 0,
    rotateDeg: 0,
    sizePct: 100,
    markOn: false,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    titleOn: true,
    titleText: "Champion",
    titleColorMode: "inherit",
    titleSizePct: 60,
    titleSub: true,
    titleBold: false,
    titleItalic: false,
    titleUnderline: false,
    titleStrike: false,
    scoredMode: "normal",
  });
  assert.match(
    code,
    /^<#12345650>Player<br><size=60%><sub><#12345650>Champion<\/sub>$/,
  );
});

test("Name Forge rerenders preserve embedded and flyout scroll positions", () => {
  const hud = { id: "rgHUD", parentElement: null };
  const body = {
    id: "rgBody",
    scrollTop: 85,
    scrollLeft: 0,
    parentElement: hud,
  };
  const forgeView = {
    id: "rgForgeView",
    scrollTop: 310,
    scrollLeft: 4,
    parentElement: body,
  };
  const panel = {
    id: "",
    scrollTop: 42,
    scrollLeft: 2,
    parentElement: forgeView,
  };
  const saved = captureForgeScroll(panel);
  panel.scrollTop = 0;
  panel.scrollLeft = 0;
  forgeView.scrollTop = 0;
  forgeView.scrollLeft = 0;
  body.scrollTop = 0;
  restoreForgeScroll(saved);
  assert.equal(panel.scrollTop, 42);
  assert.equal(panel.scrollLeft, 2);
  assert.equal(forgeView.scrollTop, 310);
  assert.equal(forgeView.scrollLeft, 4);
  assert.equal(body.scrollTop, 85);
});

test("Recently applied history is isolated and keeps five entries", () => {
  assert.equal(
    nameForgeHistoryKey("player-one"),
    "rgNameForge.history.v2.player-one",
  );
  assert.notEqual(
    nameForgeHistoryKey("player-one"),
    nameForgeHistoryKey("player-two"),
  );
  const history = ["A", "B", "C", "D", "E"].map(code => ({ code }));
  const updated = updatedRecentHistory(history, {
    code: "C",
    rawCode: "C",
    ts: 10,
  });
  assert.deepEqual(
    [...updated].map(entry => entry.code),
    ["C", "A", "B", "D", "E"],
  );
});

test("loaded raw names populate and clear the editable title field", () => {
  assert.deepEqual(
    { ...hudEditableFieldsFromRaw(
      "<#00FFFF>Stolen Name<br><size=50%><b>RGC FINALIST</b>",
    ) },
    {
      name: "Stolen Name",
      titleOn: true,
      titleText: "RGC FINALIST",
    },
  );
  assert.deepEqual(
    { ...hudEditableFieldsFromRaw("<b>Player</b>") },
    {
      name: "Player",
      titleOn: false,
      titleText: "",
    },
  );
});

test("loaded presets repair stale structured fields from rawCode", () => {
  const state = {
    name: "JESUSDIED4U SUB TO Rooted",
    titleOn: false,
    titleText: "",
    rawCode:
      "<#4C67B5>SayoshiRG<br><i><size=50%><#E53935>youtube.com/@SayoshiRG",
  };
  Object.assign(state, hudEditableFieldsFromRaw(state.rawCode));
  assert.deepEqual(
    {
      name: state.name,
      titleOn: state.titleOn,
      titleText: state.titleText,
    },
    {
      name: "SayoshiRG",
      titleOn: true,
      titleText: "youtube.com/@SayoshiRG",
    },
  );
});

test("raw-name fallback preserves sprites and excludes the title line", () => {
  assert.equal(
    hudEditableTextFromRaw(
      "<#00FFFF>St<sprite=2>olen<br><size=50%><b>RGC FINALIST</b>",
    ),
    "St<sprite=2>olenRGC FINALIST",
  );
  assert.equal(
    hudEditableFieldsFromRaw(
      "<#00FFFF>St<sprite=2>olen<br><size=50%><b>RGC FINALIST</b>",
    ).name,
    "St<sprite=2>olen",
  );
});

test("loaded raw names neutralize stale controls and preserve Hide Scored", () => {
  const state = {
    colorMode: "gradient",
    stops: ["#FF0000", "#00FF00", "#0000FF"],
    bold: true,
    titleColorMode: "gradient",
    titlePaletteKey: "Rainbow",
    scoredMode: "styled",
    scoredColor: "#FF0000",
    scoredSizePct: 200,
  };
  Object.assign(state, rawSnapshotFields("<#4C67B5>SayoshiRG"));
  assert.equal(state.colorMode, "none");
  assert.equal(state.bold, false);
  assert.equal(state.titleColorMode, "inherit");
  assert.equal(state.titlePaletteKey, null);
  state.scoredMode = "hide";
  assert.equal(effectiveForgeCode(state), "<#4C67B5>SayoshiRG<size=0>");
});

test("styled Scored modifiers round-trip without duplicate tags", () => {
  const base = "<#4C67B5>SayoshiRG";
  const state = rawSnapshotFields(base + "<size=180%><#ABCDEF>");
  assert.equal(state.rawCode, base);
  assert.equal(state.scoredMode, "styled");
  assert.equal(state.scoredSizePct, 180);
  assert.equal(state.scoredColor, "#ABCDEF");
  assert.equal(
    effectiveForgeCode(state),
    base + "<size=180%><#ABCDEF>",
  );
});

test("raw preview omits synthetic Scored text when Hide is selected", () => {
  const fakeDocument = {
    createElement(tagName) {
      return {
        tagName,
        style: {},
        children: [],
        textContent: "",
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
    },
  };
  const renderRawTMP = extractHudFunction("renderRawTMP", {
    document: fakeDocument,
    SPRITES: [],
  });
  const renderRawPreview = extractHudFunction("renderRawPreview", {
    renderRawTMP,
    scoredSuffix,
    brailleToAsciiArt,
    restorePreferredArtChars,
    artPreviewText,
  });
  const collectText = node => [
    node.textContent || "",
    ...(node.children || []).map(collectText),
  ].join("");
  const hidden = renderRawPreview(
    "<#FF0000>Player<br>Mechanical Maniac",
    { scoredMode: "hide" },
  );
  const visible = renderRawPreview(
    "<#FF0000>Player<br>Mechanical Maniac",
    { scoredMode: "default" },
  );
  assert.equal(collectText(hidden).includes("Scored!"), false);
  assert.equal(collectText(visible).includes("Scored!"), true);
});

test("stolen raw preview supports TMP color and superscript tags", () => {
  const fakeDocument = {
    createElement(tagName) {
      return {
        tagName,
        style: {},
        children: [],
        textContent: "",
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
    },
  };
  const renderRawTMP = extractHudFunction("renderRawTMP", {
    document: fakeDocument,
    SPRITES: [],
  });
  const preview = renderRawTMP(
    "<color=#000000>Croxyyys</color><br>"
      + "<sup><color=#00FFEF>Ending</color>"
      + "<color=#FF0000>Maker</sup></color>",
  );
  const [nameLine, titleLine] = preview.children;
  const firstNameLetter = nameLine.children[0];
  const firstTitleLetter = titleLine.children[0];
  const firstRedLetter = titleLine.children[6];

  assert.equal(firstNameLetter.style.color, "#000000");
  assert.equal(firstTitleLetter.style.color, "#00FFEF");
  assert.equal(firstTitleLetter.style.verticalAlign, "super");
  assert.ok(parseFloat(firstTitleLetter.style.fontSize) < 18);
  assert.equal(firstRedLetter.style.color, "#FF0000");
  assert.equal(firstRedLetter.style.verticalAlign, "super");
});

test("legacy repeated sub tags normalize to zero-width Hide Scored", () => {
  const base =
    "<#f00101>NewSoulzzs<br><sup><#ff0000>Mechanical Maniac";
  const legacy = base + " <sub>".repeat(20);
  const state = rawSnapshotFields(legacy);
  assert.equal(state.rawCode, base);
  assert.equal(state.scoredMode, "hide");
  assert.equal(effectiveForgeCode(state), base + "<size=0>");
});

test("editing a raw title preserves customization and Hide Scored", () => {
  const raw =
    "<#f00101>N<#ff0000>e<#f00101>w"
    + "<br><sup><#ff0000>O<#f00101>l<#e10202>d</sup>";
  const changed = replaceRawTitleText(raw, "New");
  assert.equal(
    changed,
    "<#f00101>N<#ff0000>e<#f00101>w"
      + "<br><sup><#ff0000>N<#f00101>e<#e10202>w</sup>",
  );
  assert.equal(hudEditableFieldsFromRaw(changed).titleText, "New");

  const state = rawSnapshotFields(
    "<#FF0000>Player<br><sup><#AA0000>Old</sup><size=0>",
  );
  state.rawCode = replaceRawTitleText(state.rawCode, "New Title");
  state.titleText = "New Title";
  assert.equal(state.scoredMode, "hide");
  assert.equal(
    effectiveForgeCode(state),
    "<#FF0000>Player<br><sup><#AA0000>New Title</sup><size=0>",
  );
});

test("trailing markup-only lines do not duplicate an edited title", () => {
  const raw =
    "<#FF0000>Player"
    + "<br><#00FFFF>Old Title"
    + "<br><rotate=0>";
  assert.equal(
    replaceRawTitleText(raw, "New Title"),
    "<#FF0000>Player"
      + "<br><#00FFFF>New Title"
      + "<br><rotate=0>",
  );
});
