import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKED_ARGUMENTS = new Set([
  "--apply",
  "--commit",
  "--delete",
  "--deploy",
  "--production",
  "--restore",
  "--update",
  "--write",
]);

export const HELP = `Compare two local Firestore baselines without changing data.

Usage:
  npm run verify:baseline -- <before-snapshot-or-manifest> <after-snapshot-or-manifest>

The report compares counts, clan roster and scoring inputs, directory and
reservation parity, and operation-budget metadata. Manifest hashes are checked
before comparison. This command does not contact Firebase.
`;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function stableText(value) {
  return JSON.stringify(stableValue(value));
}

function targetDocuments(snapshot, key) {
  const target = snapshot.targets?.[key];
  if (!target) return [];
  if (target.kind === "document") {
    return target.document ? [target.document] : [];
  }
  return target.documents || [];
}

function documentMap(snapshot, key) {
  return Object.fromEntries(
    targetDocuments(snapshot, key)
      .map(document => [document.id, document.fields || {}])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function membersForClan(clan) {
  if (Array.isArray(clan.members)) {
    return clan.members
      .filter(member => member?.userId)
      .map(member => ({ ...member }));
  }
  return Object.entries(clan.members || {}).map(([userId, member]) => ({
    userId,
    ...member,
  }));
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function deviceIdsForMember(clan, member) {
  const stats = clan.memberStats?.[member.userId] || {};
  return sortedUnique([
    member.deviceId,
    ...(member.deviceIds || []),
    stats.deviceId,
    ...(stats.deviceIds || []),
  ]);
}

function clanRosterScoring(snapshot) {
  const result = {};
  for (const [clanId, clan] of Object.entries(documentMap(snapshot, "clans"))) {
    const members = membersForClan(clan)
      .map(member => ({
        userId: member.userId,
        name: member.name ?? null,
        role: member.role ?? null,
        mmr: member.mmr ?? null,
        syncedAt: member.syncedAt ?? null,
        eventBaseline:
          member.eventBaseline ?? clan.eventBaseline?.[member.userId] ?? null,
        joinMMR: member.joinMMR ?? null,
        deviceIds: deviceIdsForMember(clan, member),
        memberStats: clan.memberStats?.[member.userId] ?? null,
      }))
      .sort((left, right) => left.userId.localeCompare(right.userId));
    result[clanId] = {
      name: clan.name ?? null,
      tag: clan.tag ?? null,
      leaderId: clan.leaderId ?? null,
      members,
      totalMMR: clan.totalMMR ?? null,
      retainedMMR: clan.retainedMMR ?? null,
    };
  }
  const event = targetDocuments(snapshot, "events/current")[0]?.fields ?? null;
  return {
    event,
    clans: result,
  };
}

function directoryMap(snapshot) {
  const result = {};
  for (const document of targetDocuments(snapshot, "clans_directory")) {
    if (document.id === "index" && Array.isArray(document.fields?.clans)) {
      for (const entry of document.fields.clans) {
        if (entry?.id) result[entry.id] = stableValue(entry);
      }
      continue;
    }
    result[document.id] = stableValue({
      id: document.id,
      ...(document.fields || {}),
    });
  }
  return stableValue(result);
}

function reservationMap(snapshot) {
  return Object.fromEntries(
    [
      "clan_name_keys",
      "clan_tag_keys",
      "clan_memberships",
      "clan_devices",
    ].map(key => [key, stableValue(documentMap(snapshot, key))]),
  );
}

function diffObjects(before, after) {
  const differences = [];
  const keys = sortedUnique([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  for (const key of keys) {
    const left = before?.[key];
    const right = after?.[key];
    if (stableText(left) !== stableText(right)) {
      differences.push({
        key,
        before: left ?? null,
        after: right ?? null,
      });
    }
  }
  return differences;
}

function expectedDirectory(snapshot) {
  const expected = {};
  for (const [clanId, clan] of Object.entries(documentMap(snapshot, "clans"))) {
    const members = membersForClan(clan);
    expected[clanId] = {
      id: clanId,
      name: clan.name ?? null,
      tag: clan.tag ?? null,
      memberCount: members.length,
      memberIds: sortedUnique(members.map(member => member.userId)),
      deviceIds: sortedUnique(
        members.flatMap(member => deviceIdsForMember(clan, member)),
      ),
    };
  }
  return expected;
}

function actualDirectoryCore(snapshot) {
  return Object.fromEntries(
    Object.entries(directoryMap(snapshot)).map(([clanId, entry]) => [
      clanId,
      {
        id: clanId,
        name: entry.name ?? null,
        tag: entry.tag ?? null,
        memberCount:
          entry.memberCount
          ?? (Array.isArray(entry.memberIds) ? entry.memberIds.length : 0),
        memberIds: sortedUnique(entry.memberIds || []),
        deviceIds: sortedUnique(entry.deviceIds || []),
      },
    ]),
  );
}

function normalizedClanName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function clanNameKey(value) {
  return createHash("sha256").update(normalizedClanName(value)).digest("hex");
}

function expectedReservations(snapshot) {
  const result = {
    clan_name_keys: {},
    clan_tag_keys: {},
    clan_memberships: {},
    clan_devices: {},
  };
  for (const [clanId, clan] of Object.entries(documentMap(snapshot, "clans"))) {
    const members = membersForClan(clan);
    const nameKey = clan.nameKey || clanNameKey(clan.name);
    const tagKey = clan.tagKey || String(clan.tag || "").trim().toUpperCase();
    result.clan_name_keys[nameKey] = {
      clanId,
      normalizedName: normalizedClanName(clan.name),
    };
    result.clan_tag_keys[tagKey] = {
      clanId,
      tag: tagKey,
    };
    for (const member of members) {
      const deviceIds = deviceIdsForMember(clan, member);
      result.clan_memberships[member.userId] = {
        clanId,
        role: member.role ?? null,
        deviceIds,
      };
      for (const deviceId of deviceIds) {
        result.clan_devices[deviceId] = {
          clanId,
          userId: member.userId,
        };
      }
    }
  }
  return result;
}

function actualReservationCore(snapshot) {
  const actual = reservationMap(snapshot);
  return {
    clan_name_keys: Object.fromEntries(
      Object.entries(actual.clan_name_keys).map(([key, value]) => [
        key,
        {
          clanId: value.clanId ?? null,
          normalizedName:
            value.normalizedName ?? normalizedClanName(value.name),
        },
      ]),
    ),
    clan_tag_keys: Object.fromEntries(
      Object.entries(actual.clan_tag_keys).map(([key, value]) => [
        key,
        {
          clanId: value.clanId ?? null,
          tag: value.tag ?? key,
        },
      ]),
    ),
    clan_memberships: Object.fromEntries(
      Object.entries(actual.clan_memberships).map(([key, value]) => [
        key,
        {
          clanId: value.clanId ?? null,
          role: value.role ?? null,
          deviceIds: sortedUnique(value.deviceIds || []),
        },
      ]),
    ),
    clan_devices: Object.fromEntries(
      Object.entries(actual.clan_devices).map(([key, value]) => [
        key,
        {
          clanId: value.clanId ?? null,
          userId: value.userId ?? null,
        },
      ]),
    ),
  };
}

export function snapshotParity(snapshot) {
  const directoryIssues = diffObjects(
    expectedDirectory(snapshot),
    actualDirectoryCore(snapshot),
  );
  const expected = expectedReservations(snapshot);
  const actual = actualReservationCore(snapshot);
  const reservationIssues = Object.fromEntries(
    Object.keys(expected).map(key => [
      key,
      diffObjects(expected[key], actual[key]),
    ]),
  );
  return {
    directory: {
      exact: directoryIssues.length === 0,
      issues: directoryIssues,
    },
    reservations: {
      exact: Object.values(reservationIssues)
        .every(issues => issues.length === 0),
      issues: reservationIssues,
    },
  };
}

export function compareSnapshots(before, after) {
  const counts = diffObjects(
    before.collectionCounts || {},
    after.collectionCounts || {},
  );
  const rosterAndScoring = diffObjects(
    clanRosterScoring(before),
    clanRosterScoring(after),
  );
  const directory = diffObjects(directoryMap(before), directoryMap(after));
  const reservations = diffObjects(
    reservationMap(before),
    reservationMap(after),
  );
  const operationBudget = stableText(before.operationBudget)
    === stableText(after.operationBudget)
    ? []
    : [{
      key: "operationBudget",
      before: before.operationBudget ?? null,
      after: after.operationBudget ?? null,
    }];
  const beforeParity = snapshotParity(before);
  const afterParity = snapshotParity(after);
  const unchanged = [
    counts,
    rosterAndScoring,
    directory,
    reservations,
    operationBudget,
  ].every(differences => differences.length === 0);

  return {
    equal: unchanged,
    afterParityExact:
      afterParity.directory.exact && afterParity.reservations.exact,
    counts: {
      equal: counts.length === 0,
      differences: counts,
    },
    clanRosterAndScoring: {
      equal: rosterAndScoring.length === 0,
      differences: rosterAndScoring,
    },
    directory: {
      equal: directory.length === 0,
      differences: directory,
      beforeParity: beforeParity.directory,
      afterParity: afterParity.directory,
    },
    reservations: {
      equal: reservations.length === 0,
      differences: reservations,
      beforeParity: beforeParity.reservations,
      afterParity: afterParity.reservations,
    },
    operationBudget: {
      equal: operationBudget.length === 0,
      differences: operationBudget,
    },
  };
}

function parseJson(text, filename) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON: ${filename}`);
  }
}

function isManifest(value) {
  return value?.hashAlgorithm === "sha256" && Array.isArray(value.files);
}

function containedFile(baseDirectory, relativePath) {
  const resolved = path.resolve(baseDirectory, relativePath);
  const root = `${path.resolve(baseDirectory)}${path.sep}`;
  if (!resolved.startsWith(root)) {
    throw new Error(`Manifest path escapes its directory: ${relativePath}`);
  }
  return resolved;
}

export async function loadSnapshotInput(filename) {
  const resolved = path.resolve(filename);
  const value = parseJson(await readFile(resolved, "utf8"), resolved);
  if (!isManifest(value)) return value;

  const baseDirectory = path.dirname(resolved);
  for (const file of value.files) {
    const artifactPath = containedFile(baseDirectory, file.path);
    const text = await readFile(artifactPath, "utf8");
    const digest = createHash("sha256").update(text).digest("hex");
    if (digest !== file.sha256) {
      throw new Error(`SHA-256 mismatch: ${file.path}`);
    }
    if (Buffer.byteLength(text) !== file.bytes) {
      throw new Error(`Byte count mismatch: ${file.path}`);
    }
  }
  const snapshotFile = value.files.find(file => file.path === "snapshot.json");
  if (!snapshotFile) throw new Error("Manifest does not include snapshot.json");
  const snapshotPath = containedFile(baseDirectory, snapshotFile.path);
  const snapshot = parseJson(await readFile(snapshotPath, "utf8"), snapshotPath);
  if (stableText(snapshot.collectionCounts) !== stableText(value.collectionCounts)) {
    throw new Error("Manifest collection counts do not match snapshot.json");
  }
  return snapshot;
}

export function parseVerifyArguments(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }
  for (const argument of args) {
    const key = argument.includes("=")
      ? argument.slice(0, argument.indexOf("="))
      : argument;
    if (BLOCKED_ARGUMENTS.has(key)) {
      throw new Error(`${key} is blocked: baseline verification is read-only`);
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (args.length !== 2) {
    throw new Error("Provide exactly two snapshot files or manifests");
  }
  return {
    help: false,
    before: args[0],
    after: args[1],
  };
}

export async function runVerifyCommand(args) {
  const options = parseVerifyArguments(args);
  if (options.help) return { help: true };
  const [before, after] = await Promise.all([
    loadSnapshotInput(options.before),
    loadSnapshotInput(options.after),
  ]);
  return {
    help: false,
    report: compareSnapshots(before, after),
  };
}

async function main() {
  const result = await runVerifyCommand(process.argv.slice(2));
  if (result.help) {
    process.stdout.write(HELP);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  if (!result.report.equal || !result.report.afterParityExact) {
    process.exitCode = 1;
  }
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
