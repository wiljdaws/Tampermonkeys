# atlas-appcheck

Cloudflare Worker that mints Firebase App Check tokens for the ATLAS HUD.
Runs on Cloudflare's free tier (100k requests/day). No Firebase Blaze plan
needed.

## Why

reCAPTCHA v3 doesn't work reliably inside the Unity WebGL page context on
`rocketgoal.io`, so the HUD can't attest itself with the standard App Check
provider. This Worker replaces that path: the HUD sends its Firebase Auth
idToken to the Worker, the Worker verifies it, checks the uid against the
`admin/allowlist` doc, and hands back a Firebase-signed App Check token.

## Deploy (first time)

1. Install wrangler if you haven't: `npm i -g wrangler`
2. `wrangler login` — pairs the CLI to your Cloudflare account.
3. Get a Firebase service account key:
   Firebase Console → Project Settings → Service accounts →
   "Generate new private key". Downloads a JSON file. Keep it out of git.
4. From `worker/`, set the secret:
   ```
   wrangler secret put FIREBASE_SERVICE_ACCOUNT
   ```
   Paste the entire JSON (as one line) when prompted.
5. Deploy:
   ```
   wrangler deploy
   ```
6. Note the URL wrangler prints (e.g. `https://atlas-appcheck.YOURSUB.workers.dev`).
   Hand it to me and I'll drop it into the HUD.

## Allowlist source

The Worker reads `admin/allowlist` from Firestore using its service account
(bypassing rules) and expects a field named `uids` that's an array of strings.
If the current allowlist lives somewhere else, edit `ALLOWLIST_DOC_PATH` and
`ALLOWLIST_FIELD` in `wrangler.toml` and redeploy.

If no allowlist doc exists yet, create one at `admin/allowlist` with a `uids`
array field containing every allowed firebaseAuthUid.

## Redeploy after changes

```
wrangler deploy
```

## Rotate the service account key

1. In Firebase Console, revoke the old key.
2. Generate a new one and download the JSON.
3. `wrangler secret put FIREBASE_SERVICE_ACCOUNT` — paste the new JSON.
4. `wrangler deploy`. Old key stops working, new key takes effect immediately.

## Tail logs

```
wrangler tail
```

Shows live request/response pairs. Useful when the HUD is failing to attest
and you need to see why.

## Endpoints

- `POST /mint` — the only endpoint. Body: `{ uid, idToken }`. Returns
  `{ token, expireTimeMillis }` on success, or `{ error: "..." }` with
  400/401/403/500 status codes.
- Everything else returns 404.

## Cost check

Free tier: 100k requests/day. Each HUD user fetches ~1 token per hour = 24
requests/user/day. At 50 users that's 1,200 requests/day — 1.2% of the free
quota. Won't cost anything at ATLAS scale.
