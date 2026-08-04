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
import { fileURLToPath } from "node:url";

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

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const rules = await readFile(
  path.join(workspace, "firestore.rules"),
  "utf8",
);
const rulesMode = process.env.RULES_MODE || "final";
const compatibilityMode = rulesMode === "compatibility";

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
      minVersion: 16.0,
    });
    await setDoc(doc(db, "admin", "migration"), {
      allowLegacyClanWrites: compatibilityMode,
    });
  });
});

function publicDb() {
  return environment.unauthenticatedContext().firestore();
}

function adminDb() {
  return environment
    .authenticatedContext("admin-user", {
      email: "therootedengineer@gmail.com",
    })
    .firestore();
}

function nonAdminDb() {
  return environment
    .authenticatedContext("signed-in-user", {
      email: "not-an-admin@example.com",
    })
    .firestore();
}

function nameKey(name) {
  return createHash("sha256")
    .update(name.trim().replace(/\s+/g, " ").toLowerCase())
    .digest("hex");
}

function member(userId, {
  role = "member",
  deviceIds = [`device-${userId}`],
  mmr = 1000,
} = {}) {
  return {
    userId,
    name: `Name ${userId}`,
    role,
    mmr,
    deviceIds,
  };
}

function strictClan({
  name = "Clan One",
  tag = "ONE",
  members = [
    member("player-a", {
      role: "leader",
      deviceIds: ["device-a"],
    }),
  ],
  joinRequests = [],
} = {}) {
  const memberMap = Object.fromEntries(
    members.map(value => [value.userId, value]),
  );
  const leader = members.find(value => value.role === "leader");
  const deviceIds = [...new Set(
    members.flatMap(value => value.deviceIds),
  )];
  return {
    name,
    normalizedName: name.trim().replace(/\s+/g, " ").toLowerCase(),
    nameKey: nameKey(name),
    tag,
    tagKey: tag,
    leaderId: leader.userId,
    deviceId: leader.deviceIds[0],
    lockVersion: 1,
    versionNum: 16.0,
    members: memberMap,
    memberIds: members.map(value => value.userId),
    deviceIds,
    joinRequests,
    totalMMR: members.reduce((total, value) => total + value.mmr, 0),
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

async function writeStrictClan(db, clanId, clan) {
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
    for (const userId of clan.memberIds) {
      const value = clan.members[userId];
      transaction.set(doc(db, "clan_memberships", userId), {
        clanId,
        role: value.role,
        deviceIds: value.deviceIds,
      });
      for (const deviceId of value.deviceIds) {
        transaction.set(doc(db, "clan_devices", deviceId), {
          clanId,
          userId,
        });
      }
    }
  });
}

async function seedStrictClan(clanId, clan) {
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "clans", clanId), clan);
    await setDoc(
      doc(db, "clans_directory", clanId),
      directoryEntry(clanId, clan),
    );
    await setDoc(doc(db, "clan_name_keys", clan.nameKey), {
      clanId,
      name: clan.name,
      normalizedName: clan.normalizedName,
    });
    await setDoc(doc(db, "clan_tag_keys", clan.tagKey), {
      clanId,
      tag: clan.tag,
    });
    for (const userId of clan.memberIds) {
      const value = clan.members[userId];
      await setDoc(doc(db, "clan_memberships", userId), {
        clanId,
        role: value.role,
        deviceIds: value.deviceIds,
      });
      for (const deviceId of value.deviceIds) {
        await setDoc(doc(db, "clan_devices", deviceId), {
          clanId,
          userId,
        });
      }
    }
  });
}

function submissionPayload(overrides = {}) {
  return {
    sourceUserId: "player-a",
    nickname: "Player Alpha",
    displayName: "Player Alpha",
    xp: 1000,
    ratings: {
      Competitive1v1: 1200,
      Competitive2v2: 1300,
      Competitive3v3: 1400,
      Casual: 500,
    },
    stats: {
      Competitive1v1: { wins: 10, matchesPlayed: 20 },
    },
    deviceId: "device-a",
    scriptVersion: "16.0",
    versionNum: 16.0,
    lastWriteAt: serverTimestamp(),
    ...overrides,
  };
}

function leaderboardPayload(overrides = {}) {
  return {
    sourceUserId: "player-a",
    playlist: "1v1",
    name: "Player Alpha",
    mmr: 1200,
    deviceId: "device-a",
    scriptVersion: "16.0",
    versionNum: 16.0,
    lastWriteAt: serverTimestamp(),
    ...overrides,
  };
}

test("rules mode is explicit", () => {
  assert.ok(["compatibility", "final"].includes(rulesMode));
  assert.ok(rules.includes("rules_version = '2';"));
});

test("only client paths are publicly readable", async () => {
  const paths = [
    ["leaderboard", "row"],
    ["script_submissions", "player-a"],
    ["iconKey", "champion"],
    ["atlas_config", "hud"],
    ["events", "current"],
    ["clans", "clan-one"],
    ["clans_directory", "clan-one"],
    ["clan_name_keys", "name"],
    ["clan_tag_keys", "ONE"],
    ["clan_memberships", "player-a"],
    ["clan_devices", "device-a"],
    ["clan_notices", "player-a"],
    ["admin", "blacklist"],
    ["admin", "clanPerms"],
  ];
  await environment.withSecurityRulesDisabled(async context => {
    for (const [collection, id] of paths) {
      await setDoc(doc(context.firestore(), collection, id), { value: true });
    }
    await setDoc(doc(context.firestore(), "private", "row"), { value: true });
    await setDoc(doc(context.firestore(), "admin", "migration"), {
      allowLegacyClanWrites: compatibilityMode,
    });
  });

  for (const [collection, id] of paths) {
    await assertSucceeds(getDoc(doc(publicDb(), collection, id)));
  }
  await assertFails(getDoc(doc(publicDb(), "private", "row")));
  await assertFails(getDoc(doc(publicDb(), "admin", "migration")));
});

test("sensitive config writes require an admin", async () => {
  for (const [collection, id] of [
    ["iconKey", "champion"],
    ["atlas_config", "hud"],
    ["events", "current"],
    ["admin", "blacklist"],
    ["admin", "clanPerms"],
  ]) {
    await assertFails(
      setDoc(doc(nonAdminDb(), collection, id), { changed: true }),
    );
    await assertSucceeds(
      setDoc(doc(adminDb(), collection, id), { changed: true }),
    );
  }
});

test("sourced leaderboard rows use deterministic IDs", async () => {
  const db = publicDb();
  await assertSucceeds(
    setDoc(
      doc(db, "script_submissions", "player-a"),
      submissionPayload(),
    ),
  );
  await assertSucceeds(
    setDoc(
      doc(db, "leaderboard", "player-a_1v1"),
      leaderboardPayload(),
    ),
  );
  await assertSucceeds(setDoc(
    doc(adminDb(), "leaderboard", "player-a_1v1"),
    {
      flag: "US",
      icons: "https://example.invalid/icon.png",
      iconSize: 20,
      glowColor: "#00bfff",
      glowStrength: 4,
      updatedAt: "2026-08-02T00:00:00.000Z",
    },
    { merge: true },
  ));
  await assertSucceeds(setDoc(
    doc(db, "leaderboard", "player-a_1v1"),
    leaderboardPayload({ mmr: 1250 }),
    { merge: true },
  ));
  assert.equal(
    (await getDoc(doc(db, "leaderboard", "player-a_1v1"))).data().glowColor,
    "#00bfff",
  );
  await assertFails(
    setDoc(
      doc(db, "leaderboard", "random-id"),
      leaderboardPayload(),
    ),
  );
  await assertFails(
    setDoc(doc(db, "leaderboard", "manual"), {
      playlist: "1v1",
      name: "Manual",
      mmr: 1000,
    }),
  );
  await assertSucceeds(
    setDoc(doc(adminDb(), "leaderboard", "manual"), {
      playlist: "1v1",
      name: "Manual",
      mmr: 1000,
      flag: "US",
    }),
  );
});

test("optional current streak remains compatible with merged submissions", async () => {
  const db = publicDb();
  const ref = doc(db, "script_submissions", "player-a");

  await assertSucceeds(setDoc(
    ref,
    submissionPayload({
      currentStreak: 6,
      scriptVersion: "17.0",
      versionNum: 17.0,
    }),
    { merge: true },
  ));
  await assertSucceeds(setDoc(
    ref,
    submissionPayload({
      scriptVersion: "16.2",
      versionNum: 16.2,
    }),
    { merge: true },
  ));
  assert.equal((await getDoc(ref)).data().currentStreak, 6);

  await assertSucceeds(setDoc(
    ref,
    submissionPayload({
      currentStreak: -2,
      scriptVersion: "17.0",
      versionNum: 17.0,
    }),
    { merge: true },
  ));
  assert.equal((await getDoc(ref)).data().currentStreak, -2);
});

test("version floor and blacklist block sourced writes", async () => {
  const db = publicDb();
  await assertFails(
    setDoc(
      doc(db, "script_submissions", "player-a"),
      submissionPayload({ versionNum: 15.9 }),
    ),
  );
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "admin", "blacklist"), {
      userIds: ["player-a"],
      deviceIds: [],
      minVersion: 16.0,
    });
  });
  await assertFails(
    setDoc(
      doc(db, "script_submissions", "player-a"),
      submissionPayload(),
    ),
  );
});

test("strict clan create coordinates every lock and directory shard", async () => {
  const members = Array.from({ length: 4 }, (_, index) =>
    member(`player-${index}`, {
      role: index === 0 ? "leader" : "member",
      deviceIds: [`device-${index}`],
    }));
  await seedStrictClan("clan-five", strictClan({ members }));
  const next = strictClan({
    members: [
      ...members,
      member("player-4", { deviceIds: ["device-4"] }),
    ],
  });
  const db = publicDb();
  await assertSucceeds(runTransaction(db, async transaction => {
    transaction.set(doc(db, "clans", "clan-five"), next);
    transaction.set(
      doc(db, "clans_directory", "clan-five"),
      directoryEntry("clan-five", next),
    );
    transaction.set(doc(db, "clan_memberships", "player-4"), {
      clanId: "clan-five",
      role: "member",
      deviceIds: ["device-4"],
    });
    transaction.set(doc(db, "clan_devices", "device-4"), {
      clanId: "clan-five",
      userId: "player-4",
    });
  }));
  assert.equal(
    (await getDoc(doc(publicDb(), "clans", "clan-five"))).data()
      .memberIds.length,
    5,
  );
});

test("membership locks validate every known device lock", async () => {
  const devices = ["device-1", "device-2", "device-3", "device-4", "device-5"];
  const clan = strictClan({
    members: [
      member("player-a", {
        role: "leader",
        deviceIds: devices,
      }),
    ],
  });
  await assertSucceeds(writeStrictClan(publicDb(), "clan-devices", clan));

  const broken = strictClan({
    name: "Broken Clan",
    tag: "BRK",
    members: [
      member("player-b", {
        role: "leader",
        deviceIds: devices.map(value => `${value}-broken`),
      }),
    ],
  });
  const brokenDb = publicDb();
  await assertFails(runTransaction(brokenDb, async transaction => {
    const db = brokenDb;
    transaction.set(doc(db, "clans", "broken"), broken);
    transaction.set(
      doc(db, "clans_directory", "broken"),
      directoryEntry("broken", broken),
    );
    transaction.set(doc(db, "clan_name_keys", broken.nameKey), {
      clanId: "broken",
      name: broken.name,
      normalizedName: broken.normalizedName,
    });
    transaction.set(doc(db, "clan_tag_keys", broken.tagKey), {
      clanId: "broken",
      tag: broken.tag,
    });
    transaction.set(doc(db, "clan_memberships", "player-b"), {
      clanId: "broken",
      role: "leader",
      deviceIds: broken.deviceIds,
    });
    for (const deviceId of broken.deviceIds.slice(0, 4)) {
      transaction.set(doc(db, "clan_devices", deviceId), {
        clanId: "broken",
        userId: "player-b",
      });
    }
  }));
});

test("member map, top-level IDs, and lock roles stay in parity", async () => {
  const clan = strictClan();
  clan.members.ghost = member("ghost", {
    deviceIds: ["device-ghost"],
  });
  await assertFails(writeStrictClan(publicDb(), "bad-map", clan));

  const roleMismatch = strictClan({
    name: "Role Clan",
    tag: "ROL",
  });
  const roleDb = publicDb();
  await assertFails(runTransaction(roleDb, async transaction => {
    const db = roleDb;
    transaction.set(doc(db, "clans", "role-clan"), roleMismatch);
    transaction.set(
      doc(db, "clans_directory", "role-clan"),
      directoryEntry("role-clan", roleMismatch),
    );
    transaction.set(doc(db, "clan_name_keys", roleMismatch.nameKey), {
      clanId: "role-clan",
      name: roleMismatch.name,
      normalizedName: roleMismatch.normalizedName,
    });
    transaction.set(doc(db, "clan_tag_keys", roleMismatch.tagKey), {
      clanId: "role-clan",
      tag: roleMismatch.tag,
    });
    transaction.set(doc(db, "clan_memberships", "player-a"), {
      clanId: "role-clan",
      role: "member",
      deviceIds: ["device-a"],
    });
    transaction.set(doc(db, "clan_devices", "device-a"), {
      clanId: "role-clan",
      userId: "player-a",
    });
  }));
});

test("strict clans enforce join-request and version limits", async () => {
  const tooMany = strictClan({
    joinRequests: Array.from({ length: 21 }, (_, index) => ({
      userId: `request-${index}`,
    })),
  });
  await assertFails(writeStrictClan(publicDb(), "too-many", tooMany));

  const old = strictClan({ name: "Old Clan", tag: "OLD" });
  old.versionNum = 15.9;
  await assertFails(writeStrictClan(publicDb(), "old", old));

  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "admin", "blacklist"), {
      userIds: [],
      deviceIds: ["device-a"],
      minVersion: 16.0,
    });
  });
  const blocked = strictClan({
    name: "Blocked Clan",
    tag: "BLK",
  });
  await assertFails(writeStrictClan(publicDb(), "blocked", blocked));
});

test("legacy writes are temporary and cannot overwrite migrated clans", async () => {
  const legacy = {
    name: "Legacy Clan",
    tag: "LEG",
    leaderId: "player-a",
    versionNum: 16.0,
    members: [
      { userId: "player-a", role: "leader" },
    ],
    joinRequests: [],
  };
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "clans", "legacy"), legacy);
  });
  const operation = setDoc(
    doc(publicDb(), "clans", "legacy"),
    { ...legacy, totalMMR: 1200 },
  );
  if (compatibilityMode) {
    await assertSucceeds(operation);
  } else {
    await assertFails(operation);
  }
  const legacyDirectoryWrite = setDoc(
    doc(publicDb(), "clans_directory", "index"),
    {
      clans: [{
        id: "legacy",
        name: "Legacy Clan",
        tag: "LEG",
        memberIds: ["player-a"],
        deviceIds: ["device-a"],
      }],
    },
  );
  if (compatibilityMode) {
    await assertSucceeds(legacyDirectoryWrite);
  } else {
    await assertFails(legacyDirectoryWrite);
  }

  const strict = strictClan();
  await writeStrictClan(publicDb(), "strict", strict);
  await assertFails(
    setDoc(doc(publicDb(), "clans", "strict"), legacy),
  );
});

test("member and device locks release only with the clan update", async () => {
  const clan = strictClan({
    members: [
      member("player-a", {
        role: "leader",
        deviceIds: ["device-a"],
      }),
      member("player-b", {
        deviceIds: ["device-b"],
      }),
    ],
  });
  const db = publicDb();
  await seedStrictClan("release", clan);
  await assertFails(deleteDoc(doc(db, "clan_memberships", "player-b")));
  await assertFails(deleteDoc(doc(db, "clan_devices", "device-b")));

  const next = strictClan();
  await assertSucceeds(runTransaction(db, async transaction => {
    transaction.set(doc(db, "clans", "release"), next);
    transaction.set(
      doc(db, "clans_directory", "release"),
      directoryEntry("release", next),
    );
    transaction.delete(doc(db, "clan_memberships", "player-b"));
    transaction.delete(doc(db, "clan_devices", "device-b"));
  }));
});

test("admin disband requires every coordinated lock release", async () => {
  const clan = strictClan();
  const db = publicDb();
  await writeStrictClan(db, "disband", clan);

  await assertFails(deleteDoc(doc(adminDb(), "clans", "disband")));
  const signedInDb = nonAdminDb();
  await assertFails(runTransaction(signedInDb, async transaction => {
    const userDb = signedInDb;
    transaction.delete(doc(userDb, "clans", "disband"));
    transaction.delete(doc(userDb, "clans_directory", "disband"));
    transaction.delete(doc(userDb, "clan_name_keys", clan.nameKey));
    transaction.delete(doc(userDb, "clan_tag_keys", clan.tagKey));
    transaction.delete(doc(userDb, "clan_memberships", "player-a"));
    transaction.delete(doc(userDb, "clan_devices", "device-a"));
  }));

  const authenticatedAdminDb = adminDb();
  await assertSucceeds(runTransaction(authenticatedAdminDb, async transaction => {
    const userDb = authenticatedAdminDb;
    transaction.delete(doc(userDb, "clans", "disband"));
    transaction.delete(doc(userDb, "clans_directory", "disband"));
    transaction.delete(doc(userDb, "clan_name_keys", clan.nameKey));
    transaction.delete(doc(userDb, "clan_tag_keys", clan.tagKey));
    transaction.delete(doc(userDb, "clan_memberships", "player-a"));
    transaction.delete(doc(userDb, "clan_devices", "device-a"));
  }));
});

test("kick notices use the version and blacklist gate", async () => {
  await assertSucceeds(setDoc(
    doc(publicDb(), "clan_notices", "player-b"),
    {
      type: "kicked",
      clanId: "clan-one",
      sourceUserId: "player-a",
      deviceId: "device-a",
      versionNum: 16.0,
    },
  ));
  await assertFails(setDoc(
    doc(publicDb(), "clan_notices", "player-c"),
    {
      type: "kicked",
      clanId: "clan-one",
      sourceUserId: "player-a",
      deviceId: "device-a",
      versionNum: 15.9,
    },
  ));
});

test("match audits and unknown writes stay disabled", async () => {
  await assertFails(
    setDoc(doc(publicDb(), "match_audits", "receipt"), {
      versionNum: 16.0,
    }),
  );
  await assertFails(
    setDoc(doc(publicDb(), "unknown", "document"), { value: true }),
  );
});
