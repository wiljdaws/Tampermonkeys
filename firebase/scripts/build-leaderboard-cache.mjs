import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { decodeFirestoreDocument } from "./snapshot-production.mjs";

const execFileAsync = promisify(execFile);

export const CACHE_COLLECTION = "leaderboard_cache";
export const PLAYLISTS = Object.freeze(["1v1", "2v2", "3v3"]);
export const CACHE_TOP_N = 100;
export const MAX_CACHE_DOC_BYTES = 900_000;
export const SCHEMA_VERSION = 1;

const BLOCKED_ARGUMENTS = new Set([
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

export const HELP = `Build trusted playlist aggregate docs under leaderboard_cache/.

Dry run (default — no writes):
  npm run build:leaderboard-cache -- --project rgleaderboard

Apply writes after dry-run review:
  npm run build:leaderboard-cache -- --project rgleaderboard --apply

Optional:
  --playlists 1v1,2v2,3v3
  --top 100

Safety:
  - Dry run is the default.
  --apply is required for writes.
  - Client writes to leaderboard_cache are denied by rules; this script uses
    a privileged service account or admin user token.
  - Unchanged sourceHash skips the write.
  - Oversized documents are refused.
`;

function argumentKey(argument) {
  return argument.includes("=")
    ? argument.slice(0, argument.indexOf("="))
    : argument;
}

export function parseCacheArguments(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  for (const argument of args) {
    const key = argumentKey(argument);
    if (BLOCKED_ARGUMENTS.has(key)) {
      throw new Error(`${key} is blocked: use --apply for cache writes`);
    }
  }

  let project = "";
  let apply = false;
  let playlists = [...PLAYLISTS];
  let top = CACHE_TOP_N;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
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
    if (argument === "--playlists") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--playlists requires a comma-separated list");
      }
      playlists = args[index + 1]
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (argument.startsWith("--playlists=")) {
      playlists = argument
        .slice("--playlists=".length)
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);
      continue;
    }
    if (argument === "--top") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--top requires a positive integer");
      }
      top = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--top=")) {
      top = Number(argument.slice("--top=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!project) throw new Error("--project is required");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new Error("Project ID has an invalid format");
  }
  if (!Number.isInteger(top) || top < 1 || top > 500) {
    throw new Error("--top must be an integer from 1 to 500");
  }
  for (const playlist of playlists) {
    if (!PLAYLISTS.includes(playlist)) {
      throw new Error(`Unsupported playlist: ${playlist}`);
    }
  }
  if (!playlists.length) throw new Error("--playlists must not be empty");

  return { help: false, project, apply, playlists, top };
}

export function compactLeaderboardRow(raw, rank) {
  const uid = String(raw?.sourceUserId || raw?.uid || "").trim();
  const name = String(raw?.name || "").trim();
  const mmr = Number(raw?.mmr);
  if (!uid || !Number.isFinite(mmr)) return null;
  return {
    uid,
    name: name.slice(0, 120),
    mmr: Math.round(mmr),
    rank: Number(rank),
  };
}

export function sourceHashForRows(rows) {
  const payload = rows.map(row => [
    row.uid,
    row.name,
    row.mmr,
    row.rank,
  ]);
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function buildCacheDocument(playlist, rows, {
  builtAt = new Date().toISOString(),
  builder = "build-leaderboard-cache",
} = {}) {
  const compact = rows
    .map((row, index) => compactLeaderboardRow(row, index + 1))
    .filter(Boolean);
  const sourceHash = sourceHashForRows(compact);
  return {
    schemaVersion: SCHEMA_VERSION,
    playlist,
    rowCount: compact.length,
    sourceHash,
    builtAt,
    builder,
    rows: compact,
  };
}

export function estimateDocumentBytes(document) {
  return Buffer.byteLength(JSON.stringify(document), "utf8");
}

export function assertCacheDocumentSize(document, maxBytes = MAX_CACHE_DOC_BYTES) {
  const bytes = estimateDocumentBytes(document);
  if (bytes > maxBytes) {
    throw new Error(
      `${CACHE_COLLECTION}/${document.playlist} is ${bytes} bytes (max ${maxBytes})`,
    );
  }
  return bytes;
}

export function planCacheWrite(existingFields, nextDocument) {
  assertCacheDocumentSize(nextDocument);
  if (existingFields?.sourceHash === nextDocument.sourceHash
      && existingFields?.rowCount === nextDocument.rowCount
      && Number(existingFields?.schemaVersion) === nextDocument.schemaVersion) {
    return { action: "skip", reason: "sourceHash unchanged", document: nextDocument };
  }
  return { action: "write", reason: "content changed", document: nextDocument };
}

function encodeFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeFirestoreValue),
      },
    };
  }
  if (value && typeof value === "object") {
    return {
      mapValue: {
        fields: encodeFirestoreFields(value),
      },
    };
  }
  throw new Error(`Unsupported Firestore value: ${typeof value}`);
}

function encodeFirestoreFields(document) {
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => [
      key,
      encodeFirestoreValue(value),
    ]),
  );
}

function documentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
}

async function apiJson(fetchImpl, token, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-Goog-User-Project": options.quotaProject || "",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    redirect: "error",
  });
  if (options.method === "GET" && response.status === 404) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return body;
}

export async function getGcloudAccessToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
  }
  const { stdout } = await execFileAsync(
    "gcloud",
    ["auth", "print-access-token"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDSDK_METRICS_ENVIRONMENT: "atlas-leaderboard-cache",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const token = stdout.trim();
  if (!token) throw new Error("gcloud returned an empty access token");
  return token;
}

export async function queryPlaylistRows(
  fetchImpl,
  token,
  project,
  playlist,
  top = CACHE_TOP_N,
) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:runQuery`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "leaderboard" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "playlist" },
              op: "EQUAL",
              value: { stringValue: playlist },
            },
          },
          orderBy: [
            { field: { fieldPath: "mmr" }, direction: "DESCENDING" },
          ],
          limit: top,
        },
      }),
    },
  );

  const rows = [];
  for (const entry of body || []) {
    if (!entry?.document) continue;
    const decoded = decodeFirestoreDocument(entry.document);
    rows.push(decoded.fields);
  }
  return rows;
}

export async function readCacheDocument(
  fetchImpl,
  token,
  project,
  playlist,
) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}/${CACHE_COLLECTION}/${encodeURIComponent(playlist)}`,
    { method: "GET", quotaProject: project },
  );
  if (!body?.name) return null;
  return decodeFirestoreDocument(body);
}

export async function queryIconKeyRows(fetchImpl, token, project) {
  const documents = [];
  let pageToken = "";
  do {
    const url = new URL(`${documentsBase(project)}/iconKey`);
    url.searchParams.set("pageSize", "300");
    url.searchParams.set("orderBy", "__name__");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await apiJson(fetchImpl, token, url, {
      method: "GET",
      quotaProject: project,
    });
    for (const document of body.documents || []) {
      documents.push(decodeFirestoreDocument(document));
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return documents.map(document => ({
    id: document.id,
    icon: String(document.fields?.icon || "").trim(),
    label: String(document.fields?.label || "").trim(),
  })).filter(row => row.id && row.icon && row.label);
}

export function buildIconKeyManifest(rows, {
  builtAt = new Date().toISOString(),
  builder = "build-leaderboard-cache",
} = {}) {
  const compact = rows
    .map(row => ({
      id: String(row.id),
      icon: String(row.icon || "").slice(0, 500),
      label: String(row.label || "").slice(0, 100),
    }))
    .filter(row => row.id && row.icon && row.label)
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(compact))
    .digest("hex");
  return {
    schemaVersion: SCHEMA_VERSION,
    playlist: "iconKey",
    rowCount: compact.length,
    sourceHash,
    builtAt,
    builder,
    rows: compact,
  };
}

async function commitWrites(fetchImpl, token, project, writes) {
  if (!writes.length) return { writeResults: [] };
  return apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}:commit`,
    {
      method: "POST",
      quotaProject: project,
      body: JSON.stringify({ writes }),
    },
  );
}

export async function buildLeaderboardCaches({
  project,
  apply = false,
  playlists = PLAYLISTS,
  top = CACHE_TOP_N,
  fetchImpl = globalThis.fetch,
  getToken = getGcloudAccessToken,
  includeIconKey = true,
  now = () => new Date().toISOString(),
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required");
  }
  const token = await getToken();
  const builtAt = now();
  const plans = [];
  const writes = [];

  for (const playlist of playlists) {
    const rows = await queryPlaylistRows(
      fetchImpl,
      token,
      project,
      playlist,
      top,
    );
    const document = buildCacheDocument(playlist, rows, { builtAt });
    const existing = await readCacheDocument(
      fetchImpl,
      token,
      project,
      playlist,
    );
    const plan = planCacheWrite(existing?.fields || null, document);
    plans.push({ path: `${CACHE_COLLECTION}/${playlist}`, ...plan });
    if (plan.action === "write" && apply) {
      writes.push({
        update: {
          name: `projects/${project}/databases/(default)/documents/${CACHE_COLLECTION}/${playlist}`,
          fields: encodeFirestoreFields(plan.document),
        },
      });
    }
  }

  if (includeIconKey) {
    const iconRows = await queryIconKeyRows(fetchImpl, token, project);
    const document = buildIconKeyManifest(iconRows, { builtAt });
    const existing = await readCacheDocument(
      fetchImpl,
      token,
      project,
      "iconKey",
    );
    const plan = planCacheWrite(existing?.fields || null, document);
    plans.push({ path: `${CACHE_COLLECTION}/iconKey`, ...plan });
    if (plan.action === "write" && apply) {
      writes.push({
        update: {
          name: `projects/${project}/databases/(default)/documents/${CACHE_COLLECTION}/iconKey`,
          fields: encodeFirestoreFields(plan.document),
        },
      });
    }
  }

  let commitResult = null;
  if (apply && writes.length) {
    commitResult = await commitWrites(fetchImpl, token, project, writes);
  }

  return {
    project,
    apply,
    written: apply ? writes.length : 0,
    skipped: plans.filter(plan => plan.action === "skip").length,
    plannedWrites: plans.filter(plan => plan.action === "write").length,
    plans,
    commitResult,
  };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseCacheArguments(argv);
  if (parsed.help) {
    console.log(HELP);
    return { help: true };
  }

  const result = await buildLeaderboardCaches({
    project: parsed.project,
    apply: parsed.apply,
    playlists: parsed.playlists,
    top: parsed.top,
    ...options,
  });

  for (const plan of result.plans) {
    const bytes = estimateDocumentBytes(plan.document);
    console.log(
      `${plan.action.toUpperCase()} ${plan.path}`
        + ` rows=${plan.document.rowCount}`
        + ` bytes=${bytes}`
        + ` hash=${plan.document.sourceHash.slice(0, 12)}`
        + ` (${plan.reason})`,
    );
  }
  console.log(
    parsed.apply
      ? `Applied ${result.written} write(s); skipped ${result.skipped}.`
      : `Dry run: ${result.plannedWrites} write(s) planned; skipped ${result.skipped}. Re-run with --apply to write.`,
  );
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
