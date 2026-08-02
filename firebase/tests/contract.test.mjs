import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

import {
  clanNameReservationId,
  deterministicLeaderboardId,
  normalizeClanName as migrationNormalizeClanName,
  normalizeClanTag as migrationNormalizeClanTag,
  planFixture,
} from "../scripts/plan-migrations.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const fixture = JSON.parse(await readFile(
  path.join(testDirectory, "fixtures", "atlas-contract.json"),
  "utf8",
));
const hudPath = process.env.HUD_SCRIPT
  ? path.resolve(process.env.HUD_SCRIPT)
  : path.resolve(workspace, "../rg_hud.user.js");
const mainSitePath = process.env.MAIN_SITE_PATH
  ? path.resolve(process.env.MAIN_SITE_PATH)
  : path.resolve(workspace, "../../rgleaderboard");
const clanSitePath = process.env.CLAN_SITE_PATH
  ? path.resolve(process.env.CLAN_SITE_PATH)
  : path.resolve(workspace, "../../RG_Clan_leaderboard");
const hudSource = await readFile(hudPath, "utf8");

const mainModel = await import(pathToFileURL(
  path.join(mainSitePath, "src/model.js"),
));
const clanScoring = await import(pathToFileURL(
  path.join(clanSitePath, "js/scoring.js"),
));
const clanMembersModule = await import(pathToFileURL(
  path.join(clanSitePath, "js/members.js"),
));
const clanAdmin = await import(pathToFileURL(
  path.join(clanSitePath, "js/admin.js"),
));

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

const hudClanMembers = extractHudFunction("clanMembers");
const hudEffectiveStat = extractHudFunction("effectiveClanMemberStat", {
  clanMembers: hudClanMembers,
});
const hudMemberBaseline = extractHudFunction("memberEventBaseline", {
  clanMembers: hudClanMembers,
});
const hudClanBaseline = extractHudFunction("clanBaselineForCurrentEvent", {
  clanMembers: hudClanMembers,
  currentEventId: () => String(fixture.event.startTime),
});
const hudScore = extractHudFunction("computeClanEventScore", {
  clanBaselineForCurrentEvent: hudClanBaseline,
  clanMembers: hudClanMembers,
  effectiveClanMemberStat: hudEffectiveStat,
  memberEventBaseline: hudMemberBaseline,
});
const hudNormalizeClanName = extractHudFunction("normalizeClanName");
const hudNormalizeClanTag = extractHudFunction("sanitizeClanTag");

test("canonical contract is sanitized and complete", () => {
  assert.equal(fixture.metadata.containsProductionValues, false);
  for (const key of [
    "event",
    "clans",
    "directoryShards",
    "reservationLocks",
    "notices",
    "leaderboard",
    "operationBudgets",
  ]) {
    assert.ok(fixture[key], `missing contract section ${key}`);
  }
});

test("ATLAS and clan site normalize and score old and new clans identically", () => {
  const { legacy, current, expected } = fixture.clans;
  for (const clan of [legacy, current]) {
    assert.equal(hudScore(clan), expected.score);
    const websiteScore = clanScoring.scoreClan(clan, fixture.event);
    assert.equal(websiteScore.score, expected.score);
    assert.deepEqual(
      websiteScore.rows.map(row => ({
        userId: row.userId,
        name: row.name,
        mmr: row.mmr,
        baseline: row.base,
        delta: row.delta,
      })),
      expected.members,
    );
  }

  assert.equal(hudNormalizeClanName(legacy.name), expected.normalizedName);
  assert.equal(
    migrationNormalizeClanName(legacy.name),
    expected.normalizedName,
  );
  assert.equal(clanAdmin.normalizeClanName(legacy.name), expected.normalizedName);
  assert.equal(hudNormalizeClanTag(legacy.tag), expected.normalizedTag);
  assert.equal(
    migrationNormalizeClanTag(legacy.tag),
    expected.normalizedTag,
  );
  assert.equal(clanAdmin.normalizeClanTag(legacy.tag), expected.normalizedTag);
  assert.deepEqual(
    Array.from(hudClanMembers(current), member => member.userId),
    clanMembersModule.clanMembers(current).map(member => member.userId),
  );
});

test("migration output satisfies the client, directory, and lock contract", () => {
  const plan = planFixture({ clans: [fixture.clans.legacy] });
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.unresolvedConflicts.length, 0);
  const migrated = plan.clans.clanWrites[0].document;
  const expected = fixture.clans.expected;

  assert.equal(migrated.normalizedName, expected.normalizedName);
  assert.equal(
    migrated.nameKey,
    clanNameReservationId(fixture.clans.legacy.name),
  );
  assert.equal(migrated.nameKey, fixture.clans.current.nameKey);
  assert.equal(migrated.tag, expected.normalizedTag);
  assert.equal(migrated.tagKey, expected.normalizedTag);
  assert.equal(migrated.lockVersion, 1);
  assert.equal(migrated.versionNum, 16);
  assert.deepEqual(migrated.memberIds, ["player-alpha", "player-bravo"]);
  assert.deepEqual(migrated.deviceIds, [
    "device-alpha",
    "device-bravo",
    "device-bravo-alt",
  ]);
  assert.equal(hudScore(migrated), expected.score);
  assert.equal(
    clanScoring.scoreClan(migrated, fixture.event).score,
    expected.score,
  );

  const paths = new Set(plan.operations.map(operation => operation.path));
  for (const requiredPath of [
    "clans/clan-contract",
    "clans_directory/clan-contract",
    "clan_tag_keys/ABC",
    "clan_memberships/player-alpha",
    "clan_memberships/player-bravo",
    "clan_devices/device-alpha",
    "clan_devices/device-bravo",
    "clan_devices/device-bravo-alt",
  ]) {
    assert.ok(paths.has(requiredPath), `missing migration write ${requiredPath}`);
  }
});

test("main site accepts valid contract rows and quarantines invalid rows", () => {
  const oneRows = fixture.leaderboard.valid
    .filter(row => row.playlist === "1v1")
    .concat(fixture.leaderboard.invalid.filter(row => row.playlist !== "wins"));
  const oneResult = mainModel.normalizePlaylistRows(oneRows, "1v1");
  assert.deepEqual(
    oneResult.rows.map(row => row.id),
    ["manual-row", "player-alpha_1v1"],
  );
  assert.deepEqual(
    oneResult.quarantined.map(row => row.id),
    ["legacy-auto-id", "bad-playlist", "too-high_1v1"],
  );

  const winsRows = fixture.leaderboard.valid
    .filter(row => row.playlist === "wins")
    .concat(fixture.leaderboard.invalid.filter(row => row.playlist === "wins"));
  const winsResult = mainModel.normalizePlaylistRows(winsRows, "wins");
  assert.deepEqual(winsResult.rows.map(row => row.id), ["player-alpha_wins"]);
  assert.deepEqual(winsResult.quarantined.map(row => row.id), ["bad-wins_wins"]);

  for (const [key, expectedId] of Object.entries(
    fixture.leaderboard.deterministicIds,
  )) {
    const [userId, playlist] = key.split(":");
    assert.equal(deterministicLeaderboardId(userId, playlist), expectedId);
  }
});

test("leaderboard migration preserves manual rows and emits a client-valid ID", () => {
  const plan = planFixture({
    leaderboard: fixture.leaderboard.migrationInput,
  });
  assert.deepEqual(
    plan.leaderboard.manualPreserved.map(row => row.id),
    ["manual-preserved"],
  );
  const write = plan.operations.find(operation =>
    operation.action === "set"
    && operation.path === "leaderboard/migrate-player_1v1");
  assert.ok(write);
  assert.equal(write.document.glowColor, "#00bfff");
  assert.equal(write.document.updatedAt, "2026-08-02T00:00:00.000Z");
  const normalized = mainModel.normalizePlayerDocument({
    id: "migrate-player_1v1",
    ...write.document,
  }, "1v1");
  assert.equal(normalized.ok, true);
  assert.equal(normalized.player.provenance.kind, "ATLAS synced");
});

function fakeAdminFirebase(documents) {
  const operations = [];
  const transaction = {
    async get(ref) {
      const data = documents.get(ref);
      return {
        exists: () => data !== undefined,
        data: () => structuredClone(data),
      };
    },
    set(ref, value, options) {
      operations.push({ type: "set", ref, value, options });
    },
    delete(ref) {
      operations.push({ type: "delete", ref });
    },
  };
  return {
    operations,
    fb: {
      db: {},
      doc: (_db, ...parts) => parts.join("/"),
      runTransaction: async (_db, callback) => callback(transaction),
    },
  };
}

test("clan site admin disband emits every final-rule cleanup write", async () => {
  const migrated = planFixture({
    clans: [fixture.clans.legacy],
  }).clans.clanWrites[0].document;
  const documents = new Map([
    ["clans/clan-contract", migrated],
    ["clans_directory/clan-contract", fixture.directoryShards[0]],
    ["clans_directory/index", {
      clans: [{ id: "clan-contract" }, { id: "other-clan" }],
    }],
    ...Object.entries(fixture.reservationLocks.memberships)
      .map(([id, value]) => [`clan_memberships/${id}`, value]),
  ]);
  const { fb, operations } = fakeAdminFirebase(documents);

  const result = await clanAdmin.disbandClan({
    fb,
    clanId: "clan-contract",
    message: fixture.notices.adminDisband.message,
    now: fixture.notices.adminDisband.at,
    noticeType: fixture.notices.adminDisband.type,
    releaseReservations: true,
  });

  assert.equal(result.notified, 2);
  assert.equal(result.devicesReleased, 3);
  const deleted = new Set(
    operations
      .filter(operation => operation.type === "delete")
      .map(operation => operation.ref),
  );
  for (const requiredPath of [
    "clans/clan-contract",
    "clans_directory/clan-contract",
    "clan_tag_keys/ABC",
    "clan_memberships/player-alpha",
    "clan_memberships/player-bravo",
    "clan_devices/device-alpha",
    "clan_devices/device-bravo",
    "clan_devices/device-bravo-alt",
  ]) {
    assert.ok(deleted.has(requiredPath), `admin left ${requiredPath}`);
  }
  assert.ok([...deleted].some(pathname =>
    /^clan_name_keys\/[a-f0-9]{64}$/.test(pathname)));
  assert.equal(
    operations.filter(operation =>
      operation.type === "set"
      && operation.ref.startsWith("clan_notices/")).length,
    2,
  );
});
