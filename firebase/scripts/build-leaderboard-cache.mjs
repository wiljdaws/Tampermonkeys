import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { decodeFirestoreDocument } from "./snapshot-production.mjs";

const execFileAsync = promisify(execFile);

export const CACHE_COLLECTION = "leaderboard_cache";
export const PLAYLISTS = Object.freeze(["1v1", "2v2", "3v3"]);
// PLAYLISTS_WITH_WINS is the union used by the JSON emitter, which also
// publishes the wins-descending playlist for the static leaderboard site.
export const PLAYLISTS_WITH_WINS = Object.freeze(["1v1", "2v2", "3v3", "wins"]);
export const CACHE_TOP_N = 100;
export const MAX_CACHE_DOC_BYTES = 900_000;
export const SCHEMA_VERSION = 1;
export const JSON_SCHEMA_VERSION = 1;
// Fields the site renders per row. Kept in sync with the firestore.rules
// leaderboard shape (`name`, `mmr`, `wins`, `matches`, `currentStreak`,
// `flag`, `icons`, `iconSize`, `glowColor`, `glowStrength`). Nothing here
// should be a live/session field that would freeze if the JSON goes stale.
export const JSON_ROW_FIELDS = Object.freeze([
  "flag",
  "icons",
  "iconSize",
  "glowColor",
  "glowStrength",
  "wins",
  "matches",
  "currentStreak",
]);

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

Emit playlist JSON blobs (uploads to R2 when R2 env is set, otherwise
dumps to stdout):
  npm run build:leaderboard-cache -- --project rgleaderboard --emit-json
  npm run build:leaderboard-cache -- --project rgleaderboard --emit-json --skip-firestore

Optional:
  --playlists 1v1,2v2,3v3[,wins]
  --top 100
  --json-prefix leaderboard/         (R2 key prefix, default "leaderboard/")

Safety:
  - Dry run is the default.
  --apply is required for Firestore writes.
  - Client writes to leaderboard_cache are denied by rules; this script uses
    a privileged service account or admin user token.
  - Unchanged sourceHash skips the write.
  - Oversized documents are refused.
  - --emit-json without R2 env vars is a no-op upload (prints JSON to stdout).
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
  let playlists = null;
  let top = CACHE_TOP_N;
  let emitJson = false;
  let skipFirestore = false;
  let jsonPrefix = "leaderboard/";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--emit-json") {
      emitJson = true;
      continue;
    }
    if (argument === "--skip-firestore") {
      skipFirestore = true;
      continue;
    }
    if (argument === "--json-prefix") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error("--json-prefix requires a value");
      }
      jsonPrefix = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--json-prefix=")) {
      jsonPrefix = argument.slice("--json-prefix=".length);
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
  // When emitting JSON, wins is a supported playlist. Firestore-only mode
  // keeps the historical 1v1/2v2/3v3 default to preserve existing behavior.
  const allowedPlaylists = emitJson ? PLAYLISTS_WITH_WINS : PLAYLISTS;
  if (playlists === null) {
    playlists = [...allowedPlaylists];
  }
  for (const playlist of playlists) {
    if (!allowedPlaylists.includes(playlist)) {
      throw new Error(`Unsupported playlist: ${playlist}`);
    }
  }
  if (!playlists.length) throw new Error("--playlists must not be empty");
  if (skipFirestore && !emitJson) {
    throw new Error("--skip-firestore requires --emit-json");
  }
  if (typeof jsonPrefix !== "string") {
    throw new Error("--json-prefix must be a string");
  }
  if (jsonPrefix && !jsonPrefix.endsWith("/")) jsonPrefix += "/";

  return {
    help: false,
    project,
    apply,
    playlists,
    top,
    emitJson,
    skipFirestore,
    jsonPrefix,
  };
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

// Richer row for the static-JSON site. Keeps the compact ranking fields
// (uid/name/rank plus mmr or wins/matches depending on playlist) and adds
// the presentation fields the client needs to render without a second
// Firestore lookup: flag, icons, iconSize, glowColor, glowStrength.
// currentStreak is deliberately included but the caller should treat it as
// possibly stale — the JSON is rebuilt on a debounced timer, not live.
export function buildJsonRow(raw, rank, playlist) {
  const uid = String(raw?.sourceUserId || raw?.uid || "").trim();
  const name = String(raw?.name || "").trim();
  if (!uid) return null;
  const row = {
    rank: Number(rank),
    uid,
    name: name.slice(0, 120),
  };
  if (playlist === "wins") {
    const wins = Number(raw?.wins);
    const matches = Number(raw?.matches);
    if (!Number.isFinite(wins) || !Number.isFinite(matches)) return null;
    row.wins = Math.round(wins);
    row.matches = Math.round(matches);
  } else {
    const mmr = Number(raw?.mmr);
    if (!Number.isFinite(mmr)) return null;
    row.mmr = Math.round(mmr);
    // Include wins/matches when present so wins-descending views on the
    // site can share row objects with the mmr views.
    if (Number.isFinite(Number(raw?.wins))) row.wins = Math.round(Number(raw.wins));
    if (Number.isFinite(Number(raw?.matches))) {
      row.matches = Math.round(Number(raw.matches));
    }
  }
  if (raw?.flag && typeof raw.flag === "string") {
    row.flag = raw.flag.slice(0, 2048);
  }
  if (raw?.icons !== undefined && raw.icons !== null) {
    if (typeof raw.icons === "string") {
      row.icons = raw.icons.slice(0, 10000);
    } else if (Array.isArray(raw.icons)) {
      row.icons = raw.icons.slice(0, 12).map(icon => String(icon));
    }
  }
  if (Number.isFinite(Number(raw?.iconSize))) {
    row.iconSize = Number(raw.iconSize);
  }
  if (typeof raw?.glowColor === "string") {
    row.glowColor = raw.glowColor;
  }
  if (Number.isFinite(Number(raw?.glowStrength))) {
    row.glowStrength = Number(raw.glowStrength);
  }
  if (Number.isFinite(Number(raw?.currentStreak))) {
    row.currentStreak = Math.trunc(Number(raw.currentStreak));
  }
  return row;
}

// JSON blob shape:
//   { playlist, builtAt, sourceHash, schemaVersion, rowCount, rows: [...] }
// The sourceHash is a stable digest over the compact ranking fields only
// (uid/name/rank plus mmr or wins/matches) so cosmetic-only changes to
// flag/icons/glow don't cause every rebuild to write a new JSON blob.
export function buildLeaderboardJson(playlist, rows, {
  builtAt = new Date().toISOString(),
  builder = "build-leaderboard-cache",
} = {}) {
  const enriched = rows
    .map((row, index) => buildJsonRow(row, index + 1, playlist))
    .filter(Boolean);
  const compactForHash = enriched.map(row => {
    if (playlist === "wins") {
      return { uid: row.uid, name: row.name, wins: row.wins, matches: row.matches, rank: row.rank };
    }
    return { uid: row.uid, name: row.name, mmr: row.mmr, rank: row.rank };
  });
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(compactForHash))
    .digest("hex");
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    playlist,
    builtAt,
    builder,
    sourceHash,
    rowCount: enriched.length,
    rows: enriched,
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
  // The wins playlist ranks by wins DESC (matching `firestore.indexes.json`);
  // every other playlist ranks by mmr DESC.
  const orderField = playlist === "wins" ? "wins" : "mmr";
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
            { field: { fieldPath: orderField }, direction: "DESCENDING" },
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
  emitJson = false,
  skipFirestore = false,
  jsonPrefix = "leaderboard/",
  uploadJsonImpl = null,
  onJsonBlob = null,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required");
  }
  const token = await getToken();
  const builtAt = now();
  const plans = [];
  const writes = [];
  const jsonBlobs = [];
  const uploads = [];

  for (const playlist of playlists) {
    const rows = await queryPlaylistRows(
      fetchImpl,
      token,
      project,
      playlist,
      top,
    );

    // Firestore leaderboard_cache write path (unchanged behavior).
    if (!skipFirestore) {
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

    // JSON emit path — built alongside Firestore so we only run the query
    // once. Upload happens after the loop so we can report a summary.
    if (emitJson) {
      const jsonBlob = buildLeaderboardJson(playlist, rows, { builtAt });
      const key = `${jsonPrefix}${playlist}.json`;
      jsonBlobs.push({ playlist, key, blob: jsonBlob });
      if (typeof onJsonBlob === "function") {
        onJsonBlob({ playlist, key, blob: jsonBlob });
      }
    }
  }

  if (!skipFirestore && includeIconKey) {
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

  // R2 upload for each emitted JSON blob. If uploadJsonImpl isn't provided
  // (or R2 env vars are missing), we skip the upload — the CLI dumps the
  // JSON to stdout instead so operators can verify the shape locally.
  if (emitJson && typeof uploadJsonImpl === "function") {
    for (const entry of jsonBlobs) {
      try {
        const result = await uploadJsonImpl(entry.key, entry.blob, {
          sourceHash: entry.blob.sourceHash,
        });
        uploads.push({
          playlist: entry.playlist,
          key: entry.key,
          status: result?.status || 0,
          etag: result?.etag || "",
          sourceHash: entry.blob.sourceHash,
          action: "uploaded",
        });
      } catch (error) {
        uploads.push({
          playlist: entry.playlist,
          key: entry.key,
          action: "failed",
          error: error?.message || String(error),
        });
        throw error;
      }
    }
  } else if (emitJson) {
    for (const entry of jsonBlobs) {
      uploads.push({
        playlist: entry.playlist,
        key: entry.key,
        action: "skipped-no-uploader",
        sourceHash: entry.blob.sourceHash,
      });
    }
  }

  return {
    project,
    apply,
    emitJson,
    skipFirestore,
    written: apply ? writes.length : 0,
    skipped: plans.filter(plan => plan.action === "skip").length,
    plannedWrites: plans.filter(plan => plan.action === "write").length,
    plans,
    commitResult,
    jsonBlobs,
    uploads,
  };
}

// Load the R2 uploader lazily so this script keeps working with only the
// Firestore path when R2 env vars are absent (or when the module is
// imported for unit tests).
async function resolveUploader(options) {
  if (options.uploadJsonImpl) return options.uploadJsonImpl;
  try {
    const module = await import("./upload-to-r2.mjs");
    module.readR2ConfigFromEnv(); // throws R2ConfigError when unset
    return module.uploadJson;
  } catch (error) {
    if (error?.name === "R2ConfigError") return null;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseCacheArguments(argv);
  if (parsed.help) {
    console.log(HELP);
    return { help: true };
  }

  let uploadJsonImpl = null;
  if (parsed.emitJson) {
    uploadJsonImpl = await resolveUploader(options);
  }

  const result = await buildLeaderboardCaches({
    project: parsed.project,
    apply: parsed.apply,
    playlists: parsed.playlists,
    top: parsed.top,
    emitJson: parsed.emitJson,
    skipFirestore: parsed.skipFirestore,
    jsonPrefix: parsed.jsonPrefix,
    uploadJsonImpl,
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

  if (parsed.emitJson) {
    for (const upload of result.uploads) {
      const blob = result.jsonBlobs.find(entry => entry.playlist === upload.playlist);
      const rowCount = blob?.blob?.rowCount ?? 0;
      const hash = (upload.sourceHash || "").slice(0, 12);
      if (upload.action === "uploaded") {
        const bytes = blob ? estimateDocumentBytes(blob.blob) : 0;
        console.log(
          `UPLOADED ${upload.key} rows=${rowCount} bytes=${bytes} hash=${hash} status=${upload.status}`,
        );
      } else if (upload.action === "skipped-no-uploader") {
        console.log(
          `EMIT-ONLY ${upload.key} rows=${rowCount} hash=${hash} (R2 env not set — dumping JSON to stdout)`,
        );
        if (blob) console.log(JSON.stringify(blob.blob));
      } else if (upload.action === "failed") {
        console.log(`FAILED ${upload.key}: ${upload.error}`);
      }
    }
  }

  const firestoreSummary = parsed.skipFirestore
    ? "Firestore writes skipped (--skip-firestore)."
    : parsed.apply
      ? `Applied ${result.written} Firestore write(s); skipped ${result.skipped}.`
      : `Dry run: ${result.plannedWrites} Firestore write(s) planned; skipped ${result.skipped}. Re-run with --apply to write.`;
  console.log(firestoreSummary);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
