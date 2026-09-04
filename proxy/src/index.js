// RocketGoal proxy Worker.
//
// Two jobs:
//   1. Reverse-proxy https://rocketgoal.io/*, injecting ATLAS into the main
//      HTML page so users without Tampermonkey get the HUD anyway.
//   2. Serve a tiny KV-backed key/value store at /atlas/kv/:sid/:key that the
//      injected script uses to persist the Firebase Auth blob across
//      IndexedDB/localStorage wipes. Values are AES-GCM ciphertext produced
//      client-side. The Worker never sees the plaintext or the key.
//
// Vars (wrangler.toml [vars]):
//   UPSTREAM_HOST        real game host, e.g. "rocketgoal.io"
//   SCRIPT_URL           full https URL of the userscript to inject
//   KV_MAX_BODY_BYTES    stringified int, max PUT body size in bytes
//   KV_TTL_SECONDS       stringified int, expirationTtl on KV writes
//
// Bindings:
//   ATLAS_KV             KV namespace

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/atlas/kv/")) {
      return handleKv(request, url, env);
    }

    return handleProxy(request, url, env);
  },
};

// ---------- proxy ----------

async function handleProxy(request, url, env) {
  const targetUrl = new URL(url.toString());
  targetUrl.hostname = env.UPSTREAM_HOST;
  targetUrl.protocol = "https:";
  targetUrl.port = "";

  // Rebuild the request against the upstream. Preserve method, headers, body.
  // Drop the incoming Host header, fetch() will set the right one.
  const upstreamHeaders = new Headers(request.headers);
  upstreamHeaders.delete("host");

  const upstreamRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders,
    body: request.body,
    redirect: "manual",
  });

  const response = await fetch(upstreamRequest);

  // Only inject into the main HTML doc. Everything else (WebGL data, JS,
  // images, XHR) passes through untouched.
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  // CSP would block the injected external script tag. Strip on HTML only.
  const stripped = new Response(response.body, response);
  stripped.headers.delete("content-security-policy");
  stripped.headers.delete("content-security-policy-report-only");

  const rewriter = new HTMLRewriter().on("head", new ScriptInjector(env.SCRIPT_URL));

  // Server-side ad strip. Same targets as the userscript's ATLAS_AD_SELECTORS,
  // narrowed to what's expressible in HTMLRewriter's CSS-subset selectors.
  const remove = new Remover();
  for (const sel of PROXY_AD_SELECTORS) rewriter.on(sel, remove);

  return rewriter.transform(stripped);
}

const PROXY_AD_SELECTORS = [
  "ins.adsbygoogle",
  ".adsbygoogle",
  '[id^="google_ads_iframe"]',
  '[id^="google_ads_frame"]',
  '[id^="div-gpt-ad"]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication"]',
  'iframe[src*="googleadservices"]',
  'iframe[src*="googletagservices"]',
  'iframe[src*="adservice.google"]',
  'iframe[src*="imasdk.googleapis.com"]',
  'iframe[src*="unityads"]',
  'iframe[src*="applovin"]',
  "[data-ad-slot]",
  "[data-ad-client]",
  'script[src*="doubleclick.net"]',
  'script[src*="googlesyndication"]',
  'script[src*="googletagservices"]',
  'script[src*="googleadservices"]',
  'script[src*="adservice.google"]',
  'script[src*="imasdk.googleapis.com"]',
];

class Remover {
  element(element) {
    element.remove();
  }
}

class ScriptInjector {
  constructor(scriptUrl) {
    this.scriptUrl = scriptUrl;
  }
  element(element) {
    // Prepend so ATLAS runs before the game's own scripts, matching
    // Tampermonkey's @run-at document-start.
    element.prepend(
      `<script src="${escapeHtmlAttr(this.scriptUrl)}"></script>`,
      { html: true },
    );
  }
}

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- KV ----------

// /atlas/kv/:sid/:key
// GET    → { iv, ciphertext } or 404
// PUT    → body { iv, ciphertext } → 204
// DELETE → 204

async function handleKv(request, url, env) {
  const parts = url.pathname.split("/").filter(Boolean);
  // ["atlas", "kv", sid, key]
  if (parts.length !== 4) return json({ error: "bad path" }, 400);
  const sid = parts[2];
  const key = parts[3];

  if (!isValidSid(sid)) return json({ error: "bad sid" }, 400);
  if (!isValidKvKey(key)) return json({ error: "bad key" }, 400);

  const kvKey = `sid:${sid}:${key}`;

  if (request.method === "GET") {
    const value = await env.ATLAS_KV.get(kvKey);
    if (value == null) return new Response(null, { status: 404 });
    return new Response(value, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (request.method === "PUT") {
    const maxBytes = parseInt(env.KV_MAX_BODY_BYTES, 10) || 32768;
    const contentLength = parseInt(
      request.headers.get("content-length") || "0",
      10,
    );
    if (contentLength > maxBytes) return json({ error: "too large" }, 413);

    const bodyText = await request.text();
    if (bodyText.length > maxBytes) return json({ error: "too large" }, 413);

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return json({ error: "bad json" }, 400);
    }
    if (!parsed || typeof parsed.iv !== "string" || typeof parsed.ciphertext !== "string") {
      return json({ error: "bad shape" }, 400);
    }

    const ttl = parseInt(env.KV_TTL_SECONDS, 10) || 7776000;
    await env.ATLAS_KV.put(kvKey, bodyText, { expirationTtl: ttl });
    return new Response(null, { status: 204 });
  }

  if (request.method === "DELETE") {
    await env.ATLAS_KV.delete(kvKey);
    return new Response(null, { status: 204 });
  }

  return json({ error: "method not allowed" }, 405);
}

function isValidSid(sid) {
  // UUIDs and similar. 8-64 chars, safe alphabet.
  return typeof sid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(sid);
}

function isValidKvKey(key) {
  // Allow the specific keys the userscript writes. Keeps the surface tiny.
  return key === "atlasFirebaseAuthUser";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
