import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const workspaceDirectory = path.resolve(scriptDirectory, "..");
export const snapshotsDirectory = path.join(workspaceDirectory, ".snapshots");

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
  "--restore",
  "--set",
  "--update",
  "--write",
]);

export const SNAPSHOT_TARGETS = [
  { key: "events/current", kind: "document", path: "events/current" },
  { key: "clans", kind: "collection", path: "clans" },
  { key: "clans_directory", kind: "collection", path: "clans_directory" },
  { key: "clan_name_keys", kind: "collection", path: "clan_name_keys" },
  { key: "clan_tag_keys", kind: "collection", path: "clan_tag_keys" },
  { key: "clan_memberships", kind: "collection", path: "clan_memberships" },
  { key: "clan_devices", kind: "collection", path: "clan_devices" },
  { key: "clan_notices", kind: "collection", path: "clan_notices" },
  { key: "leaderboard", kind: "collection", path: "leaderboard" },
  { key: "iconKey", kind: "collection", path: "iconKey" },
  {
    key: "script_submissions",
    kind: "collection",
    path: "script_submissions",
  },
  { key: "atlas_config", kind: "collection", path: "atlas_config" },
  { key: "admin/blacklist", kind: "document", path: "admin/blacklist" },
  { key: "admin/clanPerms", kind: "document", path: "admin/clanPerms" },
  { key: "admin/migration", kind: "document", path: "admin/migration" },
];

export const HELP = `Create a read-only Firestore rollback snapshot.

Usage:
  npm run snapshot:production -- --project <firebase-project-id>

Safety:
  - --project is required.
  - This command only sends authenticated GET requests.
  - Mutation, apply, and deploy arguments are rejected.
  - Output is written only under firebase/.snapshots/.
  - Running without --project or with --help does not contact Google Cloud.
`;

function argumentKey(argument) {
  return argument.includes("=")
    ? argument.slice(0, argument.indexOf("="))
    : argument;
}

export function parseSnapshotArguments(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  for (const argument of args) {
    const key = argumentKey(argument);
    if (BLOCKED_ARGUMENTS.has(key)) {
      throw new Error(`${key} is blocked: snapshots are read-only`);
    }
  }

  let project = "";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project") {
      if (project || !args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--project requires one explicit project ID");
      }
      project = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--project=")) {
      if (project) throw new Error("--project may only be provided once");
      project = argument.slice("--project=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!project) throw new Error("--project is required");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new Error("Project ID has an invalid format");
  }

  return { help: false, project };
}

export async function getGcloudAccessToken() {
  const { stdout } = await execFileAsync(
    "gcloud",
    ["auth", "print-access-token"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDSDK_METRICS_ENVIRONMENT: "atlas-read-only-snapshot",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const token = stdout.trim();
  if (!token) throw new Error("gcloud returned an empty access token");
  return token;
}

function firestoreValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) {
    const integer = BigInt(value.integerValue);
    return Number.isSafeInteger(Number(integer))
      ? Number(integer)
      : value.integerValue;
  }
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) {
    return {
      __firestoreType: "timestamp",
      value: value.timestampValue,
    };
  }
  if ("stringValue" in value) return value.stringValue;
  if ("bytesValue" in value) return { bytesValue: value.bytesValue };
  if ("referenceValue" in value) {
    return { referenceValue: value.referenceValue };
  }
  if ("geoPointValue" in value) {
    return {
      latitude: Number(value.geoPointValue.latitude),
      longitude: Number(value.geoPointValue.longitude),
    };
  }
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(firestoreValue);
  }
  if ("mapValue" in value) {
    return firestoreFields(value.mapValue.fields || {});
  }
  return structuredClone(value);
}

function firestoreFields(fields) {
  return Object.fromEntries(
    Object.entries(fields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, firestoreValue(value)]),
  );
}

export function decodeFirestoreDocument(document, documentsRoot = "/documents/") {
  const marker = document.name.indexOf(documentsRoot);
  const relativePath = marker >= 0
    ? document.name.slice(marker + documentsRoot.length)
    : document.name;
  return {
    id: relativePath.split("/").at(-1),
    path: relativePath,
    createTime: document.createTime || null,
    updateTime: document.updateTime || null,
    fields: firestoreFields(document.fields || {}),
  };
}

function safeApiError(status, body) {
  const message = body?.error?.message || `HTTP ${status}`;
  return new Error(`Google API request failed (${status}): ${message}`);
}

async function getJson(
  fetchImpl,
  token,
  url,
  { missingIsNull = false, quotaProject = "" } = {},
) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(quotaProject ? { "X-Goog-User-Project": quotaProject } : {}),
    },
    redirect: "error",
  });
  if (missingIsNull && response.status === 404) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw safeApiError(response.status, body);
  return body;
}

function firestoreDocumentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
}

async function fetchDocument(fetchImpl, token, project, documentPath) {
  const body = await getJson(
    fetchImpl,
    token,
    `${firestoreDocumentsBase(project)}/${documentPath}`,
    { missingIsNull: true, quotaProject: project },
  );
  return body ? decodeFirestoreDocument(body) : null;
}

async function fetchCollection(fetchImpl, token, project, collectionPath) {
  const documents = [];
  let pageToken = "";
  do {
    const url = new URL(
      `${firestoreDocumentsBase(project)}/${collectionPath}`,
    );
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("orderBy", "__name__");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await getJson(fetchImpl, token, url, {
      quotaProject: project,
    });
    documents.push(
      ...(body.documents || []).map(document => decodeFirestoreDocument(document)),
    );
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

async function fetchRulesMetadata(fetchImpl, token, project) {
  try {
    const releasesUrl =
      `https://firebaserules.googleapis.com/v1/projects/${encodeURIComponent(project)}/releases?pageSize=100`;
    const releases = await getJson(fetchImpl, token, releasesUrl, {
      quotaProject: project,
    });
    const release = (releases.releases || []).find(candidate =>
      candidate.name?.endsWith("/releases/cloud.firestore"));
    if (!release?.rulesetName) {
      return {
        captured: false,
        reason: "No cloud.firestore release was visible to this account.",
      };
    }
    const ruleset = await getJson(
      fetchImpl,
      token,
      `https://firebaserules.googleapis.com/v1/${release.rulesetName}`,
      { quotaProject: project },
    );
    return {
      captured: true,
      release,
      ruleset,
    };
  } catch (error) {
    return {
      captured: false,
      reason: error.message,
    };
  }
}

async function fetchIndexMetadata(fetchImpl, token, project) {
  try {
    const indexes = [];
    let pageToken = "";
    do {
      const url = new URL(
        `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/collectionGroups/-/indexes`,
      );
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await getJson(fetchImpl, token, url, {
        quotaProject: project,
      });
      indexes.push(...(body.indexes || []));
      pageToken = body.nextPageToken || "";
    } while (pageToken);
    return {
      captured: true,
      indexes,
    };
  } catch (error) {
    return {
      captured: false,
      reason: error.message,
    };
  }
}

function targetCount(target) {
  if (target.kind === "document") return target.document ? 1 : 0;
  return target.documents.length;
}

function targetDocuments(targets, key) {
  const target = targets[key];
  if (!target) return [];
  if (target.kind === "document") {
    return target.document ? [target.document] : [];
  }
  return target.documents;
}

export function buildOperationBudget(targets) {
  const byTarget = Object.fromEntries(
    Object.entries(targets).map(([key, target]) => [key, targetCount(target)]),
  );
  const leaderboard = targetDocuments(targets, "leaderboard");
  const rankedRows = leaderboard.filter(document =>
    ["1v1", "2v2", "3v3"].includes(document.fields.playlist));
  const rowsByPlaylist = new Map();
  for (const document of leaderboard) {
    const playlist = document.fields.playlist || "invalid";
    rowsByPlaylist.set(playlist, (rowsByPlaylist.get(playlist) || 0) + 1);
  }
  const largestPlaylist = Math.min(
    100,
    Math.max(0, ...rowsByPlaylist.values()),
  );
  const directoryShards = targetDocuments(targets, "clans_directory")
    .filter(document => document.id !== "index").length;

  return {
    modelVersion: 2,
    snapshotDocumentReads: Object.values(byTarget)
      .reduce((total, count) => total + count, 0),
    byTarget,
    clientReadUpperBounds: {
      atlasColdOpponentCache: Math.min(rankedRows.length, 300),
      clanCompanionColdLoad:
        (byTarget["events/current"] || 0)
        + (byTarget.clans || 0)
        + (byTarget.clans_directory || 0),
      mainLeaderboardFullLoad:
        (byTarget.leaderboard || 0) + (byTarget.atlas_config || 0),
      activeLeaderboardLoad:
        largestPlaylist + Math.min(byTarget.iconKey || 0, 12),
      coldPopupCache:
        Math.min(largestPlaylist, 100)
        + Math.min(byTarget.atlas_config || 0, 1),
      warmPopupCache: 0,
      clanReopen:
        Math.min(byTarget["events/current"] || 0, 1)
        + 3
        + Math.min(directoryShards, 8),
    },
    clientOperationUpperBounds: {
      matchSync: { reads: 4, writes: 7 },
      structuralAction: { reads: 10, writes: 12 },
      concurrentMemberMatches: { reads: 10, writes: 10, members: 5 },
    },
    clanReservationActionDelta: {
      create: { reads: 4, writes: 4 },
      joinRequest: { reads: 2, writes: 0 },
      approveMaximum: { reads: 2, writes: 2 },
      rename: { reads: 2, writes: 2 },
      transfer: { reads: 0, writes: 2 },
    },
  };
}

function timestampForDirectory(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileDigest(text) {
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  };
}

export async function captureSnapshot({
  project,
  fetchImpl = globalThis.fetch,
  getAccessToken = getGcloudAccessToken,
  now = new Date(),
} = {}) {
  if (!project) throw new Error("--project is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const token = await getAccessToken();
  const targetEntries = await Promise.all(
    SNAPSHOT_TARGETS.map(async target => {
      if (target.kind === "document") {
        return [
          target.key,
          {
            kind: target.kind,
            path: target.path,
            document: await fetchDocument(
              fetchImpl,
              token,
              project,
              target.path,
            ),
          },
        ];
      }
      return [
        target.key,
        {
          kind: target.kind,
          path: target.path,
          documents: await fetchCollection(
            fetchImpl,
            token,
            project,
            target.path,
          ),
        },
      ];
    }),
  );
  const targets = Object.fromEntries(targetEntries);
  const [rulesMetadata, indexMetadata] = await Promise.all([
    fetchRulesMetadata(fetchImpl, token, project),
    fetchIndexMetadata(fetchImpl, token, project),
  ]);
  const collectionCounts = Object.fromEntries(
    Object.entries(targets).map(([key, target]) => [key, targetCount(target)]),
  );
  const snapshot = {
    schemaVersion: 1,
    mode: "read-only",
    project,
    database: "(default)",
    capturedAt: now.toISOString(),
    collectionCounts,
    operationBudget: buildOperationBudget(targets),
    targets,
  };

  const files = {
    "snapshot.json": jsonText(snapshot),
    "firestore-rules-metadata.json": jsonText(rulesMetadata),
    "firestore-indexes-metadata.json": jsonText(indexMetadata),
  };
  const outputDirectory = path.join(
    snapshotsDirectory,
    `${timestampForDirectory(now)}-${project}`,
  );
  const resolvedOutput = path.resolve(outputDirectory);
  const resolvedRoot = `${path.resolve(snapshotsDirectory)}${path.sep}`;
  if (!resolvedOutput.startsWith(resolvedRoot)) {
    throw new Error("Snapshot output escaped firebase/.snapshots");
  }

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (const [filename, text] of Object.entries(files)) {
    await writeFile(path.join(outputDirectory, filename), text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }

  const manifest = {
    schemaVersion: 1,
    mode: "read-only",
    project,
    database: "(default)",
    capturedAt: now.toISOString(),
    hashAlgorithm: "sha256",
    collectionCounts,
    files: Object.entries(files).map(([filename, text]) => ({
      path: filename,
      ...fileDigest(text),
    })),
  };
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    jsonText(manifest),
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );

  return {
    outputDirectory,
    manifest,
  };
}

export async function runSnapshotCommand(args, dependencies = {}) {
  const options = parseSnapshotArguments(args);
  if (options.help) {
    return { help: true };
  }
  const result = await captureSnapshot({
    project: options.project,
    ...dependencies,
  });
  return { help: false, ...result };
}

async function main() {
  const result = await runSnapshotCommand(process.argv.slice(2));
  if (result.help) {
    process.stdout.write(HELP);
    return;
  }
  process.stdout.write(
    `Read-only snapshot saved to ${result.outputDirectory}\n`,
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
