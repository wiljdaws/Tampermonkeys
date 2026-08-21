// ATLAS App Check token minter — Cloudflare Worker.
//
// Flow:
//   1. HUD POSTs { uid, idToken } to /mint.
//   2. Worker verifies idToken against Firebase's public JWKs.
//   3. Worker checks uid is on the allowlist (Firestore doc, service-account read).
//   4. Worker mints an App Check token via Firebase's exchangeCustomToken API
//      using a service-account-signed customToken JWT.
//   5. Returns { token, expireTimeMillis }.
//
// Secrets (wrangler secret put ...):
//   FIREBASE_SERVICE_ACCOUNT — full service account JSON string
//
// Vars (wrangler.toml [vars]):
//   FIREBASE_PROJECT_ID       e.g. "rgleaderboard"
//   FIREBASE_PROJECT_NUMBER   e.g. "247848634543"
//   FIREBASE_APP_ID           e.g. "1:247848634543:web:6a7e506d60544d46cc6c5a"
//   ALLOWLIST_DOC_PATH        Firestore path, e.g. "admin/allowlist"
//   ALLOWLIST_FIELD           array field on that doc, e.g. "uids"
//   CORS_ORIGIN               allowed browser origin, e.g. "https://rocketgoal.io"

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
// cloud-platform covers Firestore REST reads (allowlist lookup) and the
// Firebase App Check API (exchangeCustomToken). A narrower "firebase" scope
// isn't enough for direct Firestore REST calls.
const OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const FIREBASE_JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const APPCHECK_AUD =
  "https://firebaseappcheck.googleapis.com/google.firebase.appcheck.v1.TokenExchangeService";

// Per-Worker-instance cache. Fresh on cold start; sticky for the lifetime of
// the instance (~seconds to a few minutes on Workers).
const cache = {
  signingKey: null,
  accessToken: null, // { token, expiresAt }
  jwks: null,        // { keysByKid, expiresAt }
  allowlist: null,   // { uids: Set, expiresAt }
};

// ---------- helpers ----------

function base64UrlEncode(input) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecodeToString(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  return atob(padded);
}

function pemToArrayBuffer(pem) {
  const stripped = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(stripped);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

async function importSigningKey(env) {
  if (cache.signingKey) return cache.signingKey;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  cache.signingKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cache.signingKey;
}

async function signJwt(claims, key) {
  const header = { alg: "RS256", typ: "JWT" };
  const input = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(claims),
  )}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(sig)}`;
}

// ---------- OAuth access token for Firebase Admin API ----------

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cache.accessToken && cache.accessToken.expiresAt > now + 60) {
    return cache.accessToken.token;
  }
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const key = await importSigningKey(env);
  const jwt = await signJwt(
    {
      iss: sa.client_email,
      scope: OAUTH_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    key,
  );
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    throw new Error(`oauth token failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  cache.accessToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in,
  };
  return data.access_token;
}

// ---------- verify Firebase Auth idToken ----------

async function getFirebaseJwks() {
  const now = Math.floor(Date.now() / 1000);
  if (cache.jwks && cache.jwks.expiresAt > now) return cache.jwks.keysByKid;
  const resp = await fetch(FIREBASE_JWK_URL);
  if (!resp.ok) throw new Error("jwk fetch failed: " + resp.status);
  const jwkSet = await resp.json();
  const keysByKid = new Map();
  for (const jwk of jwkSet.keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keysByKid.set(jwk.kid, key);
  }
  cache.jwks = { keysByKid, expiresAt: now + 3600 };
  return keysByKid;
}

async function verifyIdToken(idToken, env) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed idToken");
  const header = JSON.parse(base64UrlDecodeToString(parts[0]));
  const payload = JSON.parse(base64UrlDecodeToString(parts[1]));

  const keys = await getFirebaseJwks();
  const key = keys.get(header.kid);
  if (!key) throw new Error("unknown kid");

  const sig = Uint8Array.from(base64UrlDecodeToString(parts[2]), (c) =>
    c.charCodeAt(0),
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    sig,
    signed,
  );
  if (!ok) throw new Error("bad signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error("expired");
  if (payload.iat > now + 60) throw new Error("iat in future");
  if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new Error("aud mismatch");
  if (
    payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`
  ) {
    throw new Error("iss mismatch");
  }
  if (!payload.sub) throw new Error("missing sub");
  return payload;
}

// ---------- allowlist lookup (Firestore, service-account read) ----------

async function isAllowlisted(uid, env) {
  const now = Math.floor(Date.now() / 1000);
  if (cache.allowlist && cache.allowlist.expiresAt > now) {
    return cache.allowlist.uids.has(uid);
  }
  const accessToken = await getAccessToken(env);
  const docPath = env.ALLOWLIST_DOC_PATH;
  const url =
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}` +
    `/databases/(default)/documents/${docPath}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`allowlist read failed: ${resp.status}`);
  }
  const doc = await resp.json();
  const field = doc.fields?.[env.ALLOWLIST_FIELD];
  // Accept either a map (keys are uids, e.g. admin/blacklist.allowedUserIds)
  // or a plain string array. Falls back to empty set if the field's shape
  // isn't one we recognize.
  let uids;
  if (field?.mapValue?.fields) {
    uids = new Set(Object.keys(field.mapValue.fields));
  } else if (field?.arrayValue?.values) {
    uids = new Set(
      field.arrayValue.values.map((v) => v.stringValue).filter(Boolean),
    );
  } else {
    uids = new Set();
  }
  cache.allowlist = { uids, expiresAt: now + 300 };
  return uids.has(uid);
}

// ---------- App Check token exchange ----------

async function mintAppCheckToken(uid, env) {
  const now = Math.floor(Date.now() / 1000);
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const key = await importSigningKey(env);
  // Match Firebase Admin SDK's customToken exactly. The app_id claim is
  // snake_case and is required — without it exchangeCustomToken rejects
  // with "App attestation failed."
  const customToken = await signJwt(
    {
      iss: sa.client_email,
      sub: sa.client_email,
      app_id: env.FIREBASE_APP_ID,
      aud: APPCHECK_AUD,
      iat: now,
      exp: now + 300,
    },
    key,
  );
  const accessToken = await getAccessToken(env);
  // exchangeCustomToken uses projectId (e.g. "rgleaderboard"), not the
  // numeric project number. v1beta path matches Firebase Admin SDK.
  const url =
    `https://firebaseappcheck.googleapis.com/v1beta/projects/${env.FIREBASE_PROJECT_ID}` +
    `/apps/${env.FIREBASE_APP_ID}:exchangeCustomToken`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ customToken }),
  });
  if (!resp.ok) {
    throw new Error(
      `exchangeCustomToken failed: ${resp.status} ${await resp.text()}`,
    );
  }
  return await resp.json(); // { token, ttl }
}

// ---------- request handler ----------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, env, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
      ...(extra || {}),
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/mint") {
      return json({ error: "not found" }, 404, env);
    }
    try {
      const body = await request.json();
      const uid = String(body.uid || "");
      const idToken = String(body.idToken || "");
      if (!uid || !idToken) {
        return json({ error: "missing uid or idToken" }, 400, env);
      }

      const payload = await verifyIdToken(idToken, env);
      if (payload.sub !== uid) {
        return json({ error: "uid does not match idToken sub" }, 401, env);
      }

      if (!(await isAllowlisted(uid, env))) {
        return json({ error: "uid not allowlisted" }, 403, env);
      }

      const minted = await mintAppCheckToken(uid, env);
      // Firebase App Check custom provider expects expireTimeMillis (epoch ms).
      const ttlSeconds = parseInt(String(minted.ttl || "3600s"), 10) || 3600;
      return json(
        {
          token: minted.token,
          expireTimeMillis: Date.now() + ttlSeconds * 1000,
        },
        200,
        env,
      );
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500, env);
    }
  },
};
