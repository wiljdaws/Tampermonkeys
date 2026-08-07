// Tiny Cloud Run shim that receives GCP Monitoring alert webhooks and
// posts a formatted embed to a Discord channel via its webhook URL.
//
// Deploy from this directory:
//   gcloud run deploy gcp-to-discord \
//     --source . --region us-central1 --allow-unauthenticated \
//     --set-env-vars DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...,SHARED_SECRET=some-long-random-string
//
// Then in GCP Monitoring, add a Webhook notification channel pointing at
//   https://<cloud-run-url>/?token=<SHARED_SECRET>
// so random internet POSTs can't spam your Discord channel.

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT) || 8080;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SHARED_SECRET = process.env.SHARED_SECRET || "";

if (!DISCORD_WEBHOOK_URL) {
  console.error("[gcp-to-discord] DISCORD_WEBHOOK_URL is required");
  process.exit(1);
}

const OPEN_COLOR = 0xff5a5a;
const CLOSED_COLOR = 0x4ade80;
const UNKNOWN_COLOR = 0xf59e0b;

function pickColor(state) {
  if (state === "OPEN") return OPEN_COLOR;
  if (state === "CLOSED") return CLOSED_COLOR;
  return UNKNOWN_COLOR;
}
function pickTitle(state) {
  if (state === "OPEN") return "🚨 GCP alert firing";
  if (state === "CLOSED") return "✅ GCP alert resolved";
  return "⚠️ GCP alert update";
}

function buildDiscordPayload(gcp) {
  const incident = gcp?.incident || {};
  const state = String(incident.state || "").toUpperCase();
  const summary = incident.summary || "GCP Monitoring alert";
  const url = incident.url || "";
  const policy = incident.policy_name || incident.policy_user_labels?.name || "";
  const condition = incident.condition_name || incident.condition?.displayName || "";
  const resource = incident.resource_display_name || incident.resource?.type || "";
  const threshold = incident.condition?.conditionThreshold?.thresholdValue;
  const observed = incident.observed_value;

  const fields = [];
  if (policy) fields.push({ name: "Policy", value: String(policy), inline: true });
  if (condition) fields.push({ name: "Condition", value: String(condition), inline: true });
  if (resource) fields.push({ name: "Resource", value: String(resource), inline: true });
  if (threshold !== undefined) fields.push({ name: "Threshold", value: String(threshold), inline: true });
  if (observed !== undefined) fields.push({ name: "Observed", value: String(observed), inline: true });

  return {
    username: "GCP Monitoring",
    embeds: [{
      title: pickTitle(state),
      description: summary.slice(0, 4000),
      color: pickColor(state),
      url: url || undefined,
      fields: fields.slice(0, 25),
      timestamp: new Date().toISOString(),
      footer: { text: incident.incident_id ? `Incident ${incident.incident_id.slice(0, 12)}` : "GCP Monitoring" },
    }],
  };
}

async function postToDiscord(payload) {
  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`discord ${response.status}: ${body.slice(0, 200)}`);
  }
}

function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readBody(req, cap = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > cap) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("POST only");
    return;
  }
  try {
    const parsed = new URL(req.url, "http://placeholder");
    const token = parsed.searchParams.get("token") || req.headers["x-shared-secret"];
    if (SHARED_SECRET && !timingSafeEqual(token, SHARED_SECRET)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad token");
      return;
    }
    const raw = await readBody(req);
    const gcp = JSON.parse(raw || "{}");
    const payload = buildDiscordPayload(gcp);
    await postToDiscord(payload);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  } catch (err) {
    console.error("[gcp-to-discord] failed:", err.message || err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("error");
  }
});

server.listen(PORT, () => {
  console.log(`[gcp-to-discord] listening on ${PORT}`);
});
