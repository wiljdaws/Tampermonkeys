import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKED_ARGUMENTS = new Set([
  "--apply",
  "--commit",
  "--deploy",
  "--production",
  "--project",
]);

export const TARGET_VERSION = 16.0;
export const PLAN_SCHEMA_VERSION = 2;

export function deterministicLeaderboardId(sourceUserId, playlist) {
  if (!sourceUserId || !playlist) {
    throw new Error("sourceUserId and playlist are required");
  }
  return `${sourceUserId}_${playlist}`;
}

export function normalizeClanName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeClanTag(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 4);
}

export function clanNameReservationId(name) {
  return createHash("sha256").update(normalizeClanName(name)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function documentSha256(document) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(document)))
    .digest("hex");
}

function rowFields(row) {
  const fields = structuredClone(row.fields ?? row);
  delete fields.id;
  delete fields.path;
  delete fields.createTime;
  delete fields.updateTime;
  return fields;
}

function expectedDocument(row) {
  return {
    exists: true,
    sha256: documentSha256(rowFields(row)),
    ...(row.updateTime ? { updateTime: row.updateTime } : {}),
  };
}

function missingDocument() {
  return { exists: false };
}

function operationId(action, documentPath, suffix = "") {
  const seed = `${action}:${documentPath}:${suffix}`;
  return `op-${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

function setOperation({
  documentPath,
  document,
  precondition,
  destructive = false,
  reason = "",
  conditional = null,
}) {
  return {
    id: operationId(
      "set",
      documentPath,
      conditional
        ? `${conditional.conflictId}:${conditional.selectedId}`
        : documentSha256(document),
    ),
    action: "set",
    path: documentPath,
    document: structuredClone(document),
    precondition,
    destructive,
    ...(reason ? { reason } : {}),
    ...(conditional ? { conditional } : {}),
  };
}

function deleteOperation({
  documentPath,
  row,
  reason,
  conditional = null,
}) {
  return {
    id: operationId(
      "delete",
      documentPath,
      conditional
        ? `${conditional.conflictId}:${conditional.selectedId}`
        : documentSha256(rowFields(row)),
    ),
    action: "delete",
    path: documentPath,
    precondition: expectedDocument(row),
    destructive: true,
    reason,
    ...(conditional ? { conditional } : {}),
  };
}

function newestFirst(left, right) {
  const leftTime = Date.parse(left.updatedAt || left.updateTime || "") || 0;
  const rightTime = Date.parse(right.updatedAt || right.updateTime || "") || 0;
  return rightTime - leftTime || String(left.id).localeCompare(String(right.id));
}

function establishedFirst(left, right) {
  const leftTime = Date.parse(left.createdAt || "") || Number.POSITIVE_INFINITY;
  const rightTime = Date.parse(right.createdAt || "") || Number.POSITIVE_INFINITY;
  return leftTime - rightTime || String(left.id).localeCompare(String(right.id));
}

function mergedLeaderboardDocument(entries, selected) {
  const ordered = entries.slice().sort(newestFirst);
  const merged = ordered
    .slice()
    .reverse()
    .reduce(
      (result, row) => ({ ...result, ...rowFields(row) }),
      {},
    );
  return {
    ...merged,
    ...rowFields(selected),
  };
}

export function planLeaderboardMigration(rows) {
  const manual = rows.filter(row => !row.sourceUserId);
  const sourced = rows.filter(row => row.sourceUserId);
  const rowsById = new Map(rows.map(row => [row.id, row]));
  const groups = new Map();
  const operations = [];
  const conflicts = [];

  for (const row of sourced) {
    const targetId = deterministicLeaderboardId(
      row.sourceUserId,
      row.playlist,
    );
    const entries = groups.get(targetId) || [];
    entries.push(structuredClone(row));
    groups.set(targetId, entries);
  }

  for (const [targetId, entries] of groups) {
    const targetPath = `leaderboard/${targetId}`;
    const targetRow = entries.find(entry => entry.id === targetId);
    const occupiedTarget = rowsById.get(targetId);

    if (occupiedTarget && !targetRow) {
      conflicts.push({
        id: `leaderboard-target-${createHash("sha256")
          .update(targetId)
          .digest("hex")
          .slice(0, 16)}`,
        type: "leaderboard-target-collision",
        targetId,
        candidateIds: [
          occupiedTarget.id,
          ...entries.map(entry => entry.id),
        ],
        recommendation: {
          selectedId: occupiedTarget.id,
          reason: "Preserve the existing target document for manual review",
        },
        alternatives: [],
        status: "unresolved",
        manualOnly: true,
      });
      continue;
    }

    if (entries.length === 1 && targetRow) continue;

    if (entries.length === 1) {
      const source = entries[0];
      operations.push(setOperation({
        documentPath: targetPath,
        document: rowFields(source),
        precondition: missingDocument(),
        destructive: true,
        reason: `Rekey ${source.id} to its deterministic ID`,
      }));
      operations.push(deleteOperation({
        documentPath: `leaderboard/${source.id}`,
        row: source,
        reason: `Remove rekeyed source ${source.id}`,
      }));
      continue;
    }

    const conflictId = `leaderboard-${createHash("sha256")
      .update(targetId)
      .digest("hex")
      .slice(0, 16)}`;
    const candidates = entries.slice().sort(newestFirst);
    const recommended = candidates[0];
    const alternatives = [];

    for (const selected of candidates) {
      const conditional = {
        conflictId,
        selectedId: selected.id,
      };
      const selectedOperations = [];
      const targetDocument = mergedLeaderboardDocument(entries, selected);
      const targetPrecondition = targetRow
        ? expectedDocument(targetRow)
        : missingDocument();
      const targetWrite = setOperation({
        documentPath: targetPath,
        document: targetDocument,
        precondition: targetPrecondition,
        destructive: true,
        reason: `Resolve duplicate sourced rows using ${selected.id}`,
        conditional,
      });
      operations.push(targetWrite);
      selectedOperations.push(targetWrite.id);

      for (const source of entries) {
        if (source.id === targetId) continue;
        const removal = deleteOperation({
          documentPath: `leaderboard/${source.id}`,
          row: source,
          reason: `Remove superseded duplicate ${source.id}`,
          conditional,
        });
        operations.push(removal);
        selectedOperations.push(removal.id);
      }
      alternatives.push({
        selectedId: selected.id,
        operationIds: selectedOperations,
      });
    }

    conflicts.push({
      id: conflictId,
      type: "leaderboard-duplicate",
      targetId,
      candidateIds: candidates.map(candidate => candidate.id),
      recommendation: {
        selectedId: recommended.id,
        reason: "Newest sourced row, then stable document ID",
      },
      alternatives,
      status: "unresolved",
    });
  }

  return {
    manualPreserved: manual.map(row => ({
      id: row.id,
      sha256: documentSha256(rowFields(row)),
    })),
    operations,
    conflicts,
    summary: {
      inputDocuments: rows.length,
      sourcedDocuments: sourced.length,
      manualDocuments: manual.length,
      deterministicGroups: groups.size,
      operations: operations.length,
      destructiveOperations: operations.filter(operation =>
        operation.destructive).length,
      unresolvedConflicts: conflicts.length,
    },
  };
}

function memberValues(clan) {
  if (Array.isArray(clan.members)) return clan.members;
  if (clan.members && typeof clan.members === "object") {
    return Object.entries(clan.members).map(([userId, member]) => ({
      ...member,
      userId: member?.userId || userId,
    }));
  }
  return [];
}

function clanMemberDeviceIds(clan, member) {
  const ids = new Set();
  const stats = clan.memberStats?.[member.userId];
  if (member.deviceId) ids.add(member.deviceId);
  for (const deviceId of member.deviceIds || []) ids.add(deviceId);
  if (stats?.deviceId) ids.add(stats.deviceId);
  for (const deviceId of stats?.deviceIds || []) ids.add(deviceId);
  return [...ids].filter(Boolean).sort();
}

export function migrateClanShape(clan) {
  const migrated = structuredClone(clan);
  const baselines = clan.eventBaseline || {};
  const values = memberValues(clan);

  migrated.members = Object.fromEntries(
    values.map(member => {
      const deviceIds = clanMemberDeviceIds(clan, member);
      const baseline = member.eventBaseline ?? baselines[member.userId];
      return [
        member.userId,
        {
          ...structuredClone(member),
          userId: member.userId,
          deviceIds,
          ...(baseline == null ? {} : { eventBaseline: baseline }),
        },
      ];
    }),
  );

  return migrated;
}

function conflictFact(type, key, clans, details = {}) {
  const candidates = clans.slice().sort(establishedFirst);
  return {
    type,
    key,
    candidateIds: candidates.map(clan => clan.id),
    recommendation: {
      selectedId: candidates[0]?.id ?? null,
      reason: "Oldest createdAt, then stable clan ID",
    },
    ...details,
  };
}

function groupedFacts(clans, type, keyForClan) {
  const groups = new Map();
  for (const clan of clans) {
    const key = keyForClan(clan);
    if (!key) continue;
    const values = groups.get(key) || [];
    values.push(clan);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([key, values]) => conflictFact(type, key, values));
}

function clanConflictFacts(clans) {
  const facts = [
    ...groupedFacts(
      clans,
      "duplicate-name",
      clan => normalizeClanName(clan.name),
    ),
    ...groupedFacts(
      clans,
      "duplicate-tag",
      clan => normalizeClanTag(clan.tag),
    ),
  ];
  const members = new Map();
  const devices = new Map();

  for (const clan of clans) {
    for (const member of memberValues(clan)) {
      const owners = members.get(member.userId) || [];
      owners.push({ clan, member });
      members.set(member.userId, owners);
      for (const deviceId of clanMemberDeviceIds(clan, member)) {
        const deviceOwners = devices.get(deviceId) || [];
        deviceOwners.push({ clan, member });
        devices.set(deviceId, deviceOwners);
      }
    }
  }

  for (const [userId, owners] of members) {
    const uniqueClans = [...new Map(
      owners.map(owner => [owner.clan.id, owner.clan]),
    ).values()];
    if (uniqueClans.length > 1) {
      facts.push(conflictFact(
        "player-membership",
        userId,
        uniqueClans,
        { userIds: [userId] },
      ));
    }
  }

  for (const [deviceId, owners] of devices) {
    const uniqueOwners = [...new Map(
      owners.map(owner => [
        `${owner.clan.id}\u0000${owner.member.userId}`,
        owner,
      ]),
    ).values()];
    if (uniqueOwners.length > 1) {
      const uniqueClans = [...new Map(
        uniqueOwners.map(owner => [owner.clan.id, owner.clan]),
      ).values()];
      facts.push(conflictFact(
        "device-membership",
        deviceId,
        uniqueClans,
        {
          deviceId,
          userIds: uniqueOwners.map(owner => owner.member.userId).sort(),
          requiresManualMemberDecision: uniqueClans.length === 1,
        },
      ));
    }
  }

  return facts;
}

function safeField(document, key) {
  return key in document ? { [key]: structuredClone(document[key]) } : {};
}

function directoryDocument(clanId, clan) {
  return {
    clanId,
    name: clan.name,
    tag: clan.tag,
    leaderId: clan.leaderId,
    memberCount: clan.memberIds.length,
    memberIds: clan.memberIds,
    deviceIds: clan.deviceIds,
    ...safeField(clan, "createdAt"),
    ...safeField(clan, "tagStyle"),
    ...safeField(clan, "totalMMR"),
    ...safeField(clan, "eventScore"),
    ...safeField(clan, "eventId"),
  };
}

function sourceMap(rows = []) {
  return new Map(rows.map(row => [row.id, row]));
}

function writePrecondition(existingById, targetId) {
  const existing = existingById.get(targetId);
  return existing ? expectedDocument(existing) : missingDocument();
}

function clanOperations(clan, fixture) {
  const original = structuredClone(clan);
  const migrated = migrateClanShape(original);
  const values = Object.values(migrated.members);
  const memberIds = values.map(member => member.userId);
  const deviceIds = [...new Set(
    values.flatMap(member => member.deviceIds),
  )].sort();
  const leader = migrated.members[migrated.leaderId];
  const nameKey = clanNameReservationId(migrated.name);
  const tagKey = normalizeClanTag(migrated.tag);

  migrated.nameKey = nameKey;
  migrated.tag = tagKey;
  migrated.tagKey = tagKey;
  migrated.normalizedName = normalizeClanName(migrated.name);
  migrated.lockVersion = 1;
  migrated.versionNum = TARGET_VERSION;
  migrated.memberIds = memberIds;
  migrated.deviceIds = deviceIds;
  migrated.deviceId = leader.deviceIds[0];

  const directoryRows = sourceMap(fixture.clans_directory_rows);
  const nameRows = sourceMap(fixture.clan_name_keys);
  const tagRows = sourceMap(fixture.clan_tag_keys);
  const membershipRows = sourceMap(fixture.clan_memberships);
  const deviceRows = sourceMap(fixture.clan_devices);
  const operations = [
    setOperation({
      documentPath: `clans/${clan.id}`,
      document: rowFields(migrated),
      precondition: expectedDocument(clan),
    }),
    setOperation({
      documentPath: `clans_directory/${clan.id}`,
      document: directoryDocument(clan.id, migrated),
      precondition: writePrecondition(directoryRows, clan.id),
    }),
    setOperation({
      documentPath: `clan_name_keys/${nameKey}`,
      document: {
        clanId: clan.id,
        name: migrated.name,
        normalizedName: migrated.normalizedName,
      },
      precondition: writePrecondition(nameRows, nameKey),
    }),
    setOperation({
      documentPath: `clan_tag_keys/${tagKey}`,
      document: {
        clanId: clan.id,
        tag: tagKey,
      },
      precondition: writePrecondition(tagRows, tagKey),
    }),
  ];

  for (const member of values) {
    operations.push(setOperation({
      documentPath: `clan_memberships/${member.userId}`,
      document: {
        clanId: clan.id,
        role: member.role,
        deviceIds: member.deviceIds,
      },
      precondition: writePrecondition(membershipRows, member.userId),
    }));
    for (const deviceId of member.deviceIds) {
      operations.push(setOperation({
        documentPath: `clan_devices/${deviceId}`,
        document: {
          clanId: clan.id,
          userId: member.userId,
        },
        precondition: writePrecondition(deviceRows, deviceId),
      }));
    }
  }

  return {
    migrated,
    operations,
  };
}

export function planClanMigration(clans, fixture = {}) {
  const facts = clanConflictFacts(clans);
  const clansById = new Map(clans.map(clan => [clan.id, clan]));
  const blockedClanIds = new Set(
    facts.flatMap(fact => fact.candidateIds),
  );
  const missingDeviceMembers = [];
  const excessDeviceMembers = [];
  const invalidClans = [];

  for (const clan of clans) {
    const members = memberValues(clan);
    const reasons = [];
    const normalizedTag = normalizeClanTag(clan.tag);
    if (typeof clan.name !== "string"
        || clan.name.length < 1
        || clan.name.length > 24
        || !normalizeClanName(clan.name)) {
      reasons.push("invalid-name");
    }
    if (normalizedTag.length < 2) reasons.push("invalid-tag");
    if (members.length < 1 || members.length > 5) {
      reasons.push("invalid-member-count");
    }
    if (new Set(members.map(member => member?.userId)).size !== members.length
        || members.some(member => !member?.userId)) {
      reasons.push("invalid-member-ids");
    }
    const leader = members.find(member => member?.userId === clan.leaderId);
    if (!leader || leader.role !== "leader") reasons.push("invalid-leader");
    if (members.some(member =>
      !["leader", "coleader", "elder", "member"].includes(member?.role))) {
      reasons.push("invalid-role");
    }
    if (Array.isArray(clan.joinRequests) && clan.joinRequests.length > 20) {
      reasons.push("too-many-join-requests");
    }
    if (reasons.length) {
      invalidClans.push({ clanId: clan.id, reasons });
      blockedClanIds.add(clan.id);
    }

    for (const member of members) {
      const deviceIds = clanMemberDeviceIds(clan, member);
      if (!deviceIds.length) {
        missingDeviceMembers.push({
          clanId: clan.id,
          userId: member.userId,
        });
        blockedClanIds.add(clan.id);
      }
      if (deviceIds.length > 5) {
        excessDeviceMembers.push({
          clanId: clan.id,
          userId: member.userId,
          knownDeviceCount: deviceIds.length,
        });
        blockedClanIds.add(clan.id);
      }
    }
  }

  const operations = [];
  const clanWrites = [];
  const directoryWrites = [];
  const membershipWrites = [];
  const nameKeyWrites = [];
  const tagKeyWrites = [];
  const deviceWrites = [];

  for (const clan of clans.slice().sort((left, right) =>
    left.id.localeCompare(right.id))) {
    if (blockedClanIds.has(clan.id)) continue;
    const planned = clanOperations(clan, fixture);
    operations.push(...planned.operations);
    for (const operation of planned.operations) {
      const write = {
        targetId: operation.path.split("/").at(-1),
        document: operation.document,
        operationId: operation.id,
      };
      if (operation.path.startsWith("clans/")) clanWrites.push(write);
      if (operation.path.startsWith("clans_directory/")) {
        directoryWrites.push(write);
      }
      if (operation.path.startsWith("clan_memberships/")) {
        membershipWrites.push(write);
      }
      if (operation.path.startsWith("clan_name_keys/")) {
        nameKeyWrites.push(write);
      }
      if (operation.path.startsWith("clan_tag_keys/")) {
        tagKeyWrites.push(write);
      }
      if (operation.path.startsWith("clan_devices/")) {
        deviceWrites.push(write);
      }
    }
  }

  const conflicts = facts.map((fact, index) => {
    const proposedDeletions = fact.candidateIds
      .filter(clanId => clanId !== fact.recommendation.selectedId)
      .map(clanId => ({
        path: `clans/${clanId}`,
        precondition: expectedDocument(clansById.get(clanId)),
        requiresExplicitApproval: true,
      }));
    return {
      id: `clan-${String(index + 1).padStart(3, "0")}-${createHash("sha256")
        .update(`${fact.type}:${fact.key}`)
        .digest("hex")
        .slice(0, 12)}`,
      ...fact,
      status: "unresolved",
      destructivePaths: proposedDeletions.map(item => item.path),
      proposedDeletions,
      manualOnly: true,
    };
  });

  return {
    targetVersion: TARGET_VERSION,
    operations,
    clanWrites,
    directoryWrites,
    membershipWrites,
    nameKeyWrites,
    tagKeyWrites,
    deviceWrites,
    duplicateClans: conflicts.filter(conflict =>
      conflict.type === "duplicate-name"
      || conflict.type === "duplicate-tag"),
    missingDeviceMembers,
    excessDeviceMembers,
    invalidClans,
    conflicts,
    blockedClanIds: [...blockedClanIds].sort(),
    summary: {
      clans: clans.length,
      migratableClans: clanWrites.length,
      blockedClans: blockedClanIds.size,
      directoryDocuments: directoryWrites.length,
      membershipDocuments: membershipWrites.length,
      nameKeyDocuments: nameKeyWrites.length,
      tagKeyDocuments: tagKeyWrites.length,
      deviceDocuments: deviceWrites.length,
      missingDeviceMembers: missingDeviceMembers.length,
      excessDeviceMembers: excessDeviceMembers.length,
      invalidClans: invalidClans.length,
      unresolvedConflicts: conflicts.length,
    },
  };
}

function normalizeFixture(fixture) {
  if (fixture?.targets) {
    const collectionRows = key =>
      (fixture.targets[key]?.documents || []).map(document => ({
        id: document.id,
        ...structuredClone(document.fields),
        createTime: document.createTime,
        updateTime: document.updateTime,
      }));
    return {
      leaderboard: collectionRows("leaderboard"),
      clans: collectionRows("clans"),
      clans_directory_rows: collectionRows("clans_directory"),
      clan_name_keys: collectionRows("clan_name_keys"),
      clan_tag_keys: collectionRows("clan_tag_keys"),
      clan_memberships: collectionRows("clan_memberships"),
      clan_devices: collectionRows("clan_devices"),
    };
  }

  const normalized = structuredClone(fixture);
  normalized.clans_directory_rows = Array.isArray(fixture.clans_directory)
    ? fixture.clans_directory
    : [];
  return normalized;
}

export function planFixture(inputFixture) {
  const fixture = normalizeFixture(inputFixture);
  const leaderboard = planLeaderboardMigration(fixture.leaderboard || []);
  const clans = planClanMigration(fixture.clans || [], fixture);
  const operations = [
    ...leaderboard.operations,
    ...clans.operations,
  ];
  const unresolvedConflicts = [
    ...leaderboard.conflicts,
    ...clans.conflicts,
  ];
  const blockers = [
    ...clans.missingDeviceMembers.map(item => ({
      type: "missing-device",
      ...item,
    })),
    ...clans.excessDeviceMembers.map(item => ({
      type: "device-lock-limit",
      ...item,
    })),
    ...clans.invalidClans.map(item => ({
      type: "invalid-clan-shape",
      ...item,
    })),
  ];

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    release: "ATLAS 16.0",
    mode: "dry-run",
    containsProductionWrites: false,
    targetVersion: TARGET_VERSION,
    leaderboard,
    clans,
    operations,
    unresolvedConflicts,
    blockers,
    summary: {
      operations: operations.length,
      destructiveOperations: operations.filter(operation =>
        operation.destructive).length,
      unresolvedConflicts: unresolvedConflicts.length,
      blockers: blockers.length,
    },
  };
}

function parseArguments(args) {
  for (const argument of args) {
    const key = argument.includes("=")
      ? argument.slice(0, argument.indexOf("="))
      : argument;
    if (BLOCKED_ARGUMENTS.has(key)) {
      throw new Error(
        `${key} is intentionally unsupported: this planner cannot mutate production`,
      );
    }
  }

  let fixture = "";
  let output = "";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--fixture" || argument === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${argument} requires a local path`);
      }
      if (argument === "--fixture") fixture = value;
      else output = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--fixture=")) {
      fixture = argument.slice("--fixture=".length);
      continue;
    }
    if (argument.startsWith("--output=")) {
      output = argument.slice("--output=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!fixture) {
    throw new Error(
      "Usage: node scripts/plan-migrations.mjs --fixture <local-json> [--output <local-json>]",
    );
  }
  return { fixture, output };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fixturePath = path.resolve(process.cwd(), options.fixture);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const output = `${JSON.stringify(planFixture(fixture), null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(process.cwd(), options.output);
    await writeFile(outputPath, output, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`Migration plan saved to ${outputPath}\n`);
    return;
  }
  process.stdout.write(output);
}

const isEntryPoint =
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
