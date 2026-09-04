# rocketgoal-proxy

Cloudflare Worker that reverse-proxies `rocketgoal.io` and injects ATLAS from
jsDelivr, so users without Tampermonkey can play with the HUD.

Also exposes a tiny KV endpoint that the injected script uses to persist the
Firebase Auth blob across browser storage wipes. Values are encrypted
client-side with AES-GCM before they leave the browser, the Worker only ever
sees ciphertext.

## Deploy (first time)

1. Install wrangler: `npm i -g wrangler`
2. `wrangler login`
3. Create a KV namespace:
   ```
   wrangler kv namespace create ATLAS_KV
   ```
   Copy the `id` it prints into `wrangler.toml` under `[[kv_namespaces]]`.
4. Deploy:
   ```
   wrangler deploy
   ```
5. Wrangler prints the URL, e.g. `https://rocketgoal-proxy.YOURSUB.workers.dev`.
   If the output scrolls past, `wrangler whoami` shows your workers.dev
   subdomain. Share the URL with users who can't install Tampermonkey.

## How it works

- `GET /*` reverse-proxies `https://rocketgoal.io/*`.
- If the response is `text/html`, `HTMLRewriter` prepends
  `<script src="{SCRIPT_URL}"></script>` inside `<head>`. `SCRIPT_URL`
  defaults to `cdn.jsdelivr.net/gh/Pal1533/Tampermonkeys@latest/rg_hud.user.js`,
  which resolves to the newest git tag on the repo.
- Every other content type (WebGL data, images, XHR) passes through untouched.

## KV endpoint

`sid` is a random UUID the script generates and stashes in localStorage +
cookie. The script also generates a 256-bit AES-GCM key stored the same way.
The Worker never sees either. Ciphertext is scoped by `sid`, so anyone with
the sid can read/write that user's entry, which is fine because the sid is
already stored on that user's browser.

```
GET    /atlas/kv/:sid/atlasFirebaseAuthUser  -> { iv, ciphertext } | 404
PUT    /atlas/kv/:sid/atlasFirebaseAuthUser  <- { iv, ciphertext } -> 204
DELETE /atlas/kv/:sid/atlasFirebaseAuthUser                        -> 204
```

Keys are allowlisted (only `atlasFirebaseAuthUser` is accepted). Body size is
capped by `KV_MAX_BODY_BYTES`. Entries expire after `KV_TTL_SECONDS`
(default 90 days), so abandoned data reaps itself.

## Update flow

`SCRIPT_URL` uses `@latest`, which resolves to the newest git tag. To ship a
new version:

1. Bump `@version` in `rg_hud.user.js`.
2. Push to `main`. The `tag-on-version-bump` Action tags the commit and
   purges jsDelivr's cache for `@latest`.
3. Proxy users pick it up on their next page load.

No Worker redeploy needed.

## Not covered

- No rate limiting. If abuse shows up, add a Durable Object or a per-IP
  KV counter.
- No auth beyond the sid-as-capability model. That's intentional, adding
  real auth would mean the Worker holds identifying user data.
