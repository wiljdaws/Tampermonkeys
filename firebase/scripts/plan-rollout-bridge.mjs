import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  documentSha256,
  PLAN_SCHEMA_VERSION,
} from "./plan-migrations.mjs";

const BLOCKED_ARGUMENTS = new Set([
  "--apply",
  "--commit",
  "--create",
  "--delete",
  "--deploy",
  "--force",
  "--import",
  "--mutation",
  "--production",
  "--project",
  "--restore",
  "--set",
  "--update",
  "--write",
]);

export const BRIDGE_MIN_VERSION = 16.1;
export const STRUCTURAL_PERMISSION_FIELDS = [
  "allowClanCreate",
  "allowJoin",
  "allowApprove",
  "allowKick",
  "allowLeave",
  "allowRenameClan",
  "allowRoleChange",
  "allowTransfer",
  "allowDisband",
];

export const HELP = `Build the approved ATLAS 16.1 bridge plan from one local snapshot.

Usage:
  npm run plan:rollout-bridge -- \\
    --snapshot <snapshot.json> \\
    --disband-clan-id <exact-clan-id> \\
    --expect-clan-name <exact-clan-name> \\
    --min-version 16.1 \\
    --output <plan.json>

Safety:
  - Every input is local and every option is required.
  - The default and --help commands are offline.
  - Apply, deploy, project, and mutation arguments are rejected.
  - The output file is never overwritten.
`;

function argumentKey(argument) {
  return argument.includes("=")
    ? argument.slice(0, argument.indexOf("="))
    : argument;
}

function argumentValue(args, index, key) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${key} requires a value`);
  }
  return value;
}

export function parseBridgeArguments(args) {
  if (!args.length) return { help: true };

  for (const argument of args) {
    const key = argumentKey(argument);
    if (BLOCKED_ARGUMENTS.has(key)) {
      throw new Error(`${key} is blocked: this planner is local-only`);
    }
  }
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  const options = {
    help: false,
    snapshot: "",
    disbandClanId: "",
    expectClanName: "",
    minVersion: null,
    output: "",
  };
  const optionFields = new Map([
    ["--snapshot", "snapshot"],
    ["--disband-clan-id", "disbandClanId"],
    ["--expect-clan-name", "expectClanName"],
    ["--min-version", "minVersion"],
    ["--output", "output"],
  ]);
  const assigned = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(0, equals) : argument;
    const field = optionFields.get(key);
    if (!field) throw new Error(`Unknown argument: ${argument}`);
    if (assigned.has(key)) {
      throw new Error(`${key} may only be provided once`);
    }
    assigned.add(key);
    const value = equals >= 0
      ? argument.slice(equals + 1)
      : argumentValue(args, index, key);
    if (!value) throw new Error(`${key} requires a value`);
    if (equals < 0) index += 1;
    if (field === "minVersion" && value !== String(BRIDGE_MIN_VERSION)) {
      throw new Error("--min-version must be exactly 16.1 for this bridge");
    }
    options[field] = field === "minVersion" ? Number(value) : value;
  }

  for (const [key, field] of optionFields) {
    if (options[field] === "" || options[field] === null) {
      throw new Error(`${key} is required`);
    }
  }
  if (options.minVersion !== BRIDGE_MIN_VERSION) {
    throw new Error("--min-version must be exactly 16.1 for this bridge");
  }
  if (options.snapshot.includes("://") || options.output.includes("://")) {
    throw new Error("Snapshot and output must be local paths");
  }
  return options;
}

function isObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value);
}

function validateDocumentPathSegment(value, label) {
  if (typeof value !== "string"
      || !value
      || !value.trim()
      || value === "."
      || value === ".."
      || value.includes("/")) {
    throw new Error(`${label} is not a safe Firestore document ID`);
  }
}

function snapshotTarget(snapshot, key, kind) {
  const target = snapshot?.targets?.[key];
  if (!target || target.kind !== kind || target.path !== key) {
    throw new Error(`Snapshot is missing the exact ${key} ${kind} target`);
  }
  return target;
}

function collectionDocuments(snapshot, key) {
  const target = snapshotTarget(snapshot, key, "collection");
  if (!Array.isArray(target.documents)) {
    throw new Error(`Snapshot target ${key} has no documents array`);
  }
  return target.documents;
}

function validateExistingDocument(document, expectedPath) {
  if (!document
      || document.path !== expectedPath
      || !isObject(document.fields)
      || typeof document.updateTime !== "string"
      || !document.updateTime) {
    throw new Error(
      `Snapshot document ${expectedPath} needs fields and an exact updateTime`,
    );
  }
  return document;
}

function optionalSnapshotDocument(snapshot, key) {
  const target = snapshotTarget(snapshot, key, "document");
  if (target.document === null) return null;
  return validateExistingDocument(target.document, key);
}

function exactCollectionDocument(documents, collection, id, {
  required = false,
} = {}) {
  const matches = documents.filter(document => document?.id === id);
  if (matches.length > 1) {
    throw new Error(`Snapshot contains duplicate ${collection}/${id} documents`);
  }
  if (!matches.length) {
    if (required) throw new Error(`${collection}/${id} is missing`);
    return null;
  }
  return validateExistingDocument(matches[0], `${collection}/${id}`);
}

function expectedPrecondition(document) {
  if (!document) return { exists: false };
  return {
    exists: true,
    sha256: documentSha256(document.fields),
    updateTime: document.updateTime,
  };
}

function operationId(action, documentPath, precondition, document = null) {
  const seed = JSON.stringify({
    action,
    documentPath,
    precondition,
    resultSha256: document ? documentSha256(document) : null,
  });
  return `op-${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

function approvedOperation({
  action,
  documentPath,
  current,
  document = null,
  reason,
}) {
  const precondition = expectedPrecondition(current);
  return {
    id: operationId(action, documentPath, precondition, document),
    action,
    path: documentPath,
    ...(action === "set" ? { document: structuredClone(document) } : {}),
    precondition,
    destructive: true,
    requiresExplicitApproval: true,
    reason,
  };
}

function memberIdsForClan(clan) {
  const members = clan.fields.members;
  let ids = [];
  if (Array.isArray(members)) {
    ids = members.map(member => {
      if (!isObject(member) || typeof member.userId !== "string") {
        throw new Error("Every approved clan member needs an explicit userId");
      }
      return member.userId;
    });
  } else if (isObject(members)) {
    ids = Object.entries(members).map(([userId, member]) => {
      if (!isObject(member)
          || (member.userId != null && member.userId !== userId)) {
        throw new Error("Every approved clan member identity must be exact");
      }
      return userId;
    });
  } else {
    throw new Error("The approved clan has no readable member identities");
  }

  if (!ids.length) {
    throw new Error("The approved clan has no member identities");
  }
  for (const userId of ids) {
    validateDocumentPathSegment(userId, "Clan member userId");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("The approved clan has duplicate member identities");
  }
  return ids;
}

function reservationStateForClan(snapshot, clanId) {
  const paths = [];
  for (const collection of [
    "clan_name_keys",
    "clan_tag_keys",
    "clan_memberships",
    "clan_devices",
  ]) {
    for (const rawDocument of collectionDocuments(snapshot, collection)) {
      validateDocumentPathSegment(rawDocument?.id, `${collection} document ID`);
      const document = validateExistingDocument(
        rawDocument,
        `${collection}/${rawDocument.id}`,
      );
      if (document?.fields?.clanId === clanId) {
        paths.push(document.path || `${collection}/${document.id}`);
      }
    }
  }
  const directoryShard = collectionDocuments(snapshot, "clans_directory")
    .find(document => document?.id === clanId);
  if (directoryShard) {
    paths.push(directoryShard.path || `clans_directory/${clanId}`);
  }
  return paths.sort();
}

function rollbackValue(document) {
  if (!document) return { exists: false };
  return {
    exists: true,
    document: structuredClone(document.fields),
    precondition: expectedPrecondition(document),
  };
}

function fileSha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function planBridgeRollout(snapshot, {
  disbandClanId,
  expectClanName,
  minVersion,
  snapshotSha256 = "",
} = {}) {
  if (snapshot?.mode !== "read-only" || !isObject(snapshot.targets)) {
    throw new Error("Input must be one read-only snapshot");
  }
  if (typeof snapshot.capturedAt !== "string"
      || !Number.isFinite(Date.parse(snapshot.capturedAt))) {
    throw new Error("Snapshot capturedAt is missing or invalid");
  }
  validateDocumentPathSegment(disbandClanId, "--disband-clan-id");
  if (typeof expectClanName !== "string" || !expectClanName) {
    throw new Error("--expect-clan-name is required");
  }
  if (minVersion !== BRIDGE_MIN_VERSION) {
    throw new Error("The approved bridge minVersion must be exactly 16.1");
  }

  const clans = collectionDocuments(snapshot, "clans");
  const clan = exactCollectionDocument(
    clans,
    "clans",
    disbandClanId,
    { required: true },
  );
  if (clan.fields.name !== expectClanName) {
    throw new Error("Expected clan name does not match the snapshot exactly");
  }
  const memberIds = memberIdsForClan(clan);

  const directoryDocuments = collectionDocuments(snapshot, "clans_directory");
  const directory = exactCollectionDocument(
    directoryDocuments,
    "clans_directory",
    "index",
    { required: true },
  );
  if (!Array.isArray(directory.fields.clans)) {
    throw new Error("clans_directory/index has no legacy clans array");
  }
  const directoryMatches = directory.fields.clans
    .filter(entry => isObject(entry) && entry.id === disbandClanId);
  if (directoryMatches.length !== 1) {
    throw new Error(
      "Legacy directory must contain the approved clan exactly once",
    );
  }

  const reservationState = reservationStateForClan(snapshot, disbandClanId);
  if (reservationState.length) {
    throw new Error(
      "Reservation locks or directory state already exist for this clan; "
      + "use the full admin cleanup path",
    );
  }

  const eventsCurrent = optionalSnapshotDocument(snapshot, "events/current");
  if (!eventsCurrent) throw new Error("events/current is missing");
  const blacklist = optionalSnapshotDocument(snapshot, "admin/blacklist");
  const migration = optionalSnapshotDocument(snapshot, "admin/migration");
  const notices = collectionDocuments(snapshot, "clan_notices");

  const migrationDocument = {
    ...(migration ? structuredClone(migration.fields) : {}),
    allowLegacyClanWrites: true,
  };
  const blacklistDocument = {
    ...(blacklist ? structuredClone(blacklist.fields) : {}),
    minVersion,
  };
  const eventDocument = structuredClone(eventsCurrent.fields);
  eventDocument.useClanReservations = false;
  eventDocument.perms = {
    ...(isObject(eventsCurrent.fields.perms)
      ? structuredClone(eventsCurrent.fields.perms)
      : {}),
    ...Object.fromEntries(
      STRUCTURAL_PERMISSION_FIELDS.map(field => [field, false]),
    ),
  };
  const directoryDocument = {
    ...structuredClone(directory.fields),
    clans: directory.fields.clans.filter(entry =>
      !(isObject(entry) && entry.id === disbandClanId)),
  };

  const operations = [
    approvedOperation({
      action: "set",
      documentPath: "admin/migration",
      current: migration,
      document: migrationDocument,
      reason: "Enable legacy clan writes for the bridge",
    }),
    approvedOperation({
      action: "set",
      documentPath: "admin/blacklist",
      current: blacklist,
      document: blacklistDocument,
      reason: "Require the approved ATLAS version",
    }),
    approvedOperation({
      action: "set",
      documentPath: "events/current",
      current: eventsCurrent,
      document: eventDocument,
      reason: "Freeze structural clan actions and keep reservations off",
    }),
  ];

  const rollbackValues = {
    "admin/migration": rollbackValue(migration),
    "admin/blacklist": rollbackValue(blacklist),
    "events/current": rollbackValue(eventsCurrent),
    [`clans/${disbandClanId}`]: rollbackValue(clan),
    "clans_directory/index": rollbackValue(directory),
  };

  for (const userId of memberIds.slice().sort()) {
    const currentNotice = exactCollectionDocument(
      notices,
      "clan_notices",
      userId,
    );
    const noticePath = `clan_notices/${userId}`;
    const notice = {
      type: "admin_disbanded",
      clanId: disbandClanId,
      clanName: expectClanName,
      message: "The clan was disbanded.",
      at: snapshot.capturedAt,
    };
    operations.push(approvedOperation({
      action: "set",
      documentPath: noticePath,
      current: currentNotice,
      document: notice,
      reason: "Notify an approved clan member",
    }));
    rollbackValues[noticePath] = rollbackValue(currentNotice);
  }

  operations.push(
    approvedOperation({
      action: "set",
      documentPath: "clans_directory/index",
      current: directory,
      document: directoryDocument,
      reason: "Remove the approved clan from the legacy directory",
    }),
    approvedOperation({
      action: "delete",
      documentPath: `clans/${disbandClanId}`,
      current: clan,
      reason: "Disband the approved clan",
    }),
  );

  const approvalOperationIds = operations.map(operation => operation.id);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    release: "ATLAS 16.1 bridge",
    mode: "dry-run",
    containsProductionWrites: true,
    targetVersion: minVersion,
    sourceSnapshot: {
      project: snapshot.project || null,
      capturedAt: snapshot.capturedAt,
      sha256: snapshotSha256 || documentSha256(snapshot),
    },
    selection: {
      disbandClanId,
      expectedClanName: expectClanName,
    },
    operations,
    unresolvedConflicts: [],
    blockers: [],
    approval: {
      required: true,
      operationIds: approvalOperationIds,
    },
    rollbackValues,
    summary: {
      message:
        "Freeze structural clan actions, keep reservations off, enable the "
        + "compatibility bridge, require ATLAS 16.1, notify every member, "
        + "and disband one approved clan. Leaderboard rows and other clans "
        + "are untouched.",
      operations: operations.length,
      destructiveOperations: operations.length,
      approvalRequiredOperations: operations.length,
      notices: memberIds.length,
      clansDeleted: 1,
      directoryEntriesRemoved: 1,
      leaderboardOperations: 0,
      otherClanOperations: 0,
    },
  };
}

export async function runBridgePlannerCommand(args, {
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  cwd = process.cwd(),
} = {}) {
  const options = parseBridgeArguments(args);
  if (options.help) return { help: true, networkUsed: false };

  const snapshotPath = path.resolve(cwd, options.snapshot);
  const outputPath = path.resolve(cwd, options.output);
  const snapshotText = await readFileImpl(snapshotPath, "utf8");
  const snapshot = JSON.parse(snapshotText);
  const plan = planBridgeRollout(snapshot, {
    disbandClanId: options.disbandClanId,
    expectClanName: options.expectClanName,
    minVersion: options.minVersion,
    snapshotSha256: fileSha256(snapshotText),
  });
  await writeFileImpl(
    outputPath,
    `${JSON.stringify(plan, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return {
    help: false,
    networkUsed: false,
    outputPath,
    operations: plan.operations.length,
    approvalOperationIds: plan.approval.operationIds,
  };
}

async function main() {
  const result = await runBridgePlannerCommand(process.argv.slice(2));
  if (result.help) {
    process.stdout.write(HELP);
    return;
  }
  process.stdout.write(
    `Bridge plan saved to ${result.outputPath}\n`
    + `Operations needing approval: ${result.operations}\n`,
  );
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
