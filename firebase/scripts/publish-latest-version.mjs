#!/usr/bin/env node
// Push the current HUD @version into admin/latest_version so the in-HUD
// update nudge points every client at the newest build. Idempotent: no
// write happens if the doc already has the same versionNum.
//
// Usage:
//   node scripts/publish-latest-version.mjs [--project rgleaderboard] [--hud path/to/rg_hud.user.js] [--dry-run]
//
// Auth: same pattern as build-leaderboard-cache — GOOGLE_OAUTH_ACCESS_TOKEN
// from workload identity in CI, or `gcloud auth print-access-token` locally.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getGcloudAccessToken } from "./build-leaderboard-cache.mjs";

const HUD_UPDATE_URL =
  "https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js";

function parseArgs(argv) {
  const args = {
    project: "rgleaderboard",
    hud: null,
    dryRun: false,
    bumpMinVersion: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--hud") args.hud = argv[++i];
    else if (a === "--dry-run" || a === "--plan") args.dryRun = true;
    else if (a === "--bump-min-version") args.bumpMinVersion = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "publish-latest-version.mjs [--project=rgleaderboard] [--hud=path] [--dry-run] [--bump-min-version]",
      );
      process.exit(0);
    }
  }
  return args;
}

function extractHudVersion(source) {
  const match = source.match(/^\/\/\s*@version\s+([\d.]+)\s*$/m);
  if (!match) throw new Error("Could not find @version line in HUD source");
  const versionStr = match[1];
  const versionNum = Number.parseFloat(versionStr);
  if (!Number.isFinite(versionNum)) {
    throw new Error(`Unparseable @version: ${versionStr}`);
  }
  return { versionStr, versionNum };
}

async function firestoreRequest({ project, path, method, body, token }) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents/${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
  });
  if (method === "GET" && response.status === 404) return null;
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = parsed?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return parsed;
}

function readFirestoreNumber(field) {
  if (!field) return null;
  if (field.doubleValue !== undefined) return Number(field.doubleValue);
  if (field.integerValue !== undefined) return Number(field.integerValue);
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hudPath =
    args.hud || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "rg_hud.user.js");
  const source = await readFile(hudPath, "utf8");
  const { versionStr, versionNum } = extractHudVersion(source);
  console.log(`[publish-latest-version] HUD @version: ${versionStr} (${versionNum})`);

  const token = await getGcloudAccessToken();
  // Skip the idempotency read — during the 2026-08-14 incident the
  // Firestore READ quota was exhausted and this GET returned 429. The
  // PATCH below is idempotent enough on its own: writing the same
  // versionNum + updateUrl twice is a no-op. If the read quota is
  // healthy the extra write costs one op per push, which is fine.
  console.log(
    `[publish-latest-version] setting admin/latest_version.versionNum → ${versionNum}`,
  );
  if (args.dryRun) {
    console.log("[publish-latest-version] --dry-run: skipping write");
    return;
  }

  await firestoreRequest({
    project: args.project,
    path:
      "admin/latest_version?updateMask.fieldPaths=versionNum&updateMask.fieldPaths=updateUrl",
    method: "PATCH",
    body: {
      fields: {
        versionNum: { doubleValue: versionNum },
        updateUrl: { stringValue: HUD_UPDATE_URL },
      },
    },
    token,
  });
  console.log("[publish-latest-version] wrote admin/latest_version");

  // 2026-08-14 incident hardening: after the leaderboard rules and the
  // HUD both cut over to the auth-bound identity model, also bump
  // admin/blacklist.minVersion so every pre-cutover HUD is forced to
  // update. Rules read admin/blacklist.minVersion at write time.
  if (args.bumpMinVersion) {
    console.log(
      `[publish-latest-version] bumping admin/blacklist.minVersion → ${versionNum}`,
    );
    await firestoreRequest({
      project: args.project,
      path: "admin/blacklist?updateMask.fieldPaths=minVersion",
      method: "PATCH",
      body: {
        fields: {
          minVersion: { doubleValue: versionNum },
        },
      },
      token,
    });
    console.log("[publish-latest-version] wrote admin/blacklist.minVersion");
  }
}

main().catch((err) => {
  console.error("[publish-latest-version] failed:", err.message || err);
  process.exit(1);
});
