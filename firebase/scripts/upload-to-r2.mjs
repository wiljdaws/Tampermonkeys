import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

// Hand-rolled AWS SigV4 uploader for Cloudflare R2 (S3-compatible).
// We avoid @aws-sdk/client-s3 to keep the Cloud Run image slim — SigV4 is
// well-specified and a few dozen lines of Node crypto do the whole job.
//
// Env required at call time:
//   R2_ACCESS_KEY_ID        R2 API token access key
//   R2_SECRET_ACCESS_KEY    R2 API token secret
//   R2_ACCOUNT_ID           Cloudflare account ID (subdomain of r2.cloudflarestorage.com)
//   R2_BUCKET               Bucket name to write into
//
// Optional:
//   R2_REGION               Region label (SigV4 needs one; R2 accepts "auto")
//   R2_ENDPOINT_OVERRIDE    Override endpoint for local emulator testing

export const R2_REGION_DEFAULT = "auto";
export const R2_SERVICE = "s3";
export const R2_DEFAULT_CACHE_CONTROL =
  "public, max-age=15, stale-while-revalidate=60";

export class R2ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "R2ConfigError";
  }
}

export function readR2ConfigFromEnv(env = process.env) {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET;
  const region = env.R2_REGION || R2_REGION_DEFAULT;
  const endpointOverride = env.R2_ENDPOINT_OVERRIDE || "";
  const missing = [];
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!bucket) missing.push("R2_BUCKET");
  if (missing.length) {
    throw new R2ConfigError(
      `Missing R2 env: ${missing.join(", ")}`,
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    accountId,
    bucket,
    region,
    endpointOverride,
  };
}

// AWS-style URI encoding: RFC 3986 reserved except `/` in path segments.
function uriEncode(value, encodeSlash = true) {
  const buf = Buffer.from(String(value), "utf8");
  let out = "";
  for (const byte of buf) {
    const isUnreserved =
      (byte >= 0x30 && byte <= 0x39) // 0-9
      || (byte >= 0x41 && byte <= 0x5a) // A-Z
      || (byte >= 0x61 && byte <= 0x7a) // a-z
      || byte === 0x2d // -
      || byte === 0x2e // .
      || byte === 0x5f // _
      || byte === 0x7e; // ~
    if (isUnreserved) {
      out += String.fromCharCode(byte);
      continue;
    }
    if (byte === 0x2f && !encodeSlash) {
      out += "/";
      continue;
    }
    out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function encodeCanonicalPath(key) {
  return key
    .split("/")
    .map(segment => uriEncode(segment, true))
    .join("/");
}

function amzDate(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return {
    amz: iso, // 20260806T120000Z
    date: iso.slice(0, 8), // 20260806
  };
}

function hmac(key, data, encoding) {
  const mac = createHmac("sha256", key).update(data, "utf8");
  return encoding ? mac.digest(encoding) : mac.digest();
}

function sha256Hex(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function deriveSigningKey(secret, date, region, service) {
  const kDate = hmac("AWS4" + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

// Build the canonical request per SigV4 spec. Header names are lowercased,
// values are trimmed, and signed headers are sorted by name.
function buildCanonicalRequest({
  method,
  canonicalPath,
  canonicalQuery,
  headers,
  payloadHash,
}) {
  const sortedNames = Object.keys(headers)
    .map(name => name.toLowerCase())
    .sort();
  const canonicalHeaders = sortedNames
    .map(name => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  return { canonicalRequest, signedHeaders };
}

export function buildSignedRequest({
  method,
  host,
  path,
  body,
  headers,
  region,
  service,
  accessKeyId,
  secretAccessKey,
  now = new Date(),
}) {
  const { amz, date } = amzDate(now);
  const payloadHash = sha256Hex(body ?? "");
  const canonicalPath = encodeCanonicalPath(path);
  const canonicalQuery = "";
  const mergedHeaders = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    ...headers,
  };
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method,
    canonicalPath,
    canonicalQuery,
    headers: mergedHeaders,
    payloadHash,
  });
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = deriveSigningKey(secretAccessKey, date, region, service);
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`
    + `, SignedHeaders=${signedHeaders}`
    + `, Signature=${signature}`;
  return {
    headers: {
      ...mergedHeaders,
      Authorization: authorization,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

function endpointFor(config) {
  if (config.endpointOverride) return config.endpointOverride.replace(/\/$/, "");
  return `https://${config.accountId}.r2.cloudflarestorage.com`;
}

// Public entry point. Serialises `obj` as JSON, signs the PUT with SigV4, and
// uploads to `<bucket>/<key>`. Returns { status, url, etag, sourceHash }.
export async function uploadJson(key, obj, options = {}) {
  const config = options.config || readR2ConfigFromEnv(options.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required to upload to R2");
  }
  if (typeof key !== "string" || !key.length) {
    throw new Error("uploadJson: key is required");
  }
  const body = JSON.stringify(obj);
  const sourceHash =
    options.sourceHash
    || (obj && typeof obj === "object" && typeof obj.sourceHash === "string"
      ? obj.sourceHash
      : sha256Hex(body));
  const cacheControl = options.cacheControl || R2_DEFAULT_CACHE_CONTROL;
  const contentType = options.contentType || "application/json";
  const endpoint = endpointFor(config);
  const url = new URL(endpoint);
  const host = url.host;
  const path = `/${config.bucket}/${key}`;
  const now = options.now || new Date();
  const userMetadataHeader = "x-amz-meta-source-hash";

  const signed = buildSignedRequest({
    method: "PUT",
    host,
    path,
    body,
    headers: {
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "cache-control": cacheControl,
      [userMetadataHeader]: sourceHash,
    },
    region: config.region,
    service: R2_SERVICE,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now,
  });

  const fullUrl = `${endpoint}${encodeCanonicalPath(path)}`;
  const response = await fetchImpl(fullUrl, {
    method: "PUT",
    body,
    headers: signed.headers,
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `R2 upload failed (${response.status}) for ${key}: ${text.slice(0, 400)}`,
    );
  }
  return {
    status: response.status,
    url: fullUrl,
    etag: response.headers.get("etag") || "",
    sourceHash,
  };
}

export async function main(argv = process.argv.slice(2)) {
  // CLI form: node upload-to-r2.mjs <key> <path-to-json>
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node upload-to-r2.mjs <key> <path-to-json>

Reads JSON from <path-to-json> (or stdin when '-') and uploads it to R2 at
<key>. Env vars: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID,
R2_BUCKET.`);
    return;
  }
  const [key, sourcePath] = argv;
  if (!key || !sourcePath) {
    throw new Error("Usage: upload-to-r2.mjs <key> <path-to-json>");
  }
  const { readFile } = await import("node:fs/promises");
  let raw;
  if (sourcePath === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf8");
  } else {
    raw = await readFile(sourcePath, "utf8");
  }
  const parsed = JSON.parse(raw);
  const result = await uploadJson(key, parsed);
  console.log(`Uploaded ${key} -> ${result.url} (etag=${result.etag})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
