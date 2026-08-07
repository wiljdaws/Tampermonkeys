# Leaderboard rebuild service — deploy runbook

End-to-end steps to bring the `leaderboard-rebuild` Cloud Run service up
from a cold start on a new machine or a new GCP project. Follow it in
order the first time; subsequent deploys go through the GitHub Actions
workflow at `.github/workflows/deploy-rebuild-service.yml`.

- **Service**: Cloud Run, region `us-central1`, project `rgleaderboard`.
- **Entrypoint**: `firebase/scripts/cloud-run-server.mjs` (started via
  `npm run start:cloud-run` from the `firebase/` package).
- **Trigger**: Cloud Scheduler job `leaderboard-rebuild-cron` firing
  `POST /rebuild` every minute; the server rebuilds the top-100 JSON
  blobs and uploads them to Cloudflare R2.
- **Related workflows**: `.github/workflows/firebase-tests.yml` gates
  correctness (rules + emulator + cache builder unit tests). This
  runbook only covers infra/deploy plumbing.

## Prerequisites

- `gcloud` CLI ≥ 466 authenticated (`gcloud auth login`) as a principal
  with these roles in `rgleaderboard`:
    - `roles/run.admin`
    - `roles/secretmanager.admin`
    - `roles/cloudscheduler.admin`
    - `roles/iam.serviceAccountUser` on the Cloud Run runtime SA
- Cloudflare account with an R2 bucket already provisioned (or ready to
  provision in Step 1) and access to the dashboard for API-token creation.
- A registered custom domain if you want the JSON blobs served from
  `leaderboard.example.com` instead of the default `*.r2.dev` URL. The
  service itself doesn't care — this only affects the frontend fetch URL.

---

## Step 1 — Create the R2 bucket + API token

1. Sign in to the Cloudflare dashboard → **R2** → **Create bucket**.
    - Name: `rgleaderboard` (or whatever you'll set as `R2_BUCKET`).
    - Location hint: Automatic. Public-access can stay off; we serve via
      a custom domain or signed URLs from the frontend.
2. Note the **Account ID** (top-right of the R2 dashboard) — this maps
   to `R2_ACCOUNT_ID` and forms the S3 endpoint hostname
   `https://<account-id>.r2.cloudflarestorage.com`.
3. Under **R2** → **Manage R2 API Tokens** → **Create API Token**.
    - Permissions: **Object Read & Write**.
    - Bucket scope: the bucket you just created.
    - TTL: no expiry (or rotate on your normal cadence).
4. Copy the **Access Key ID** and **Secret Access Key**. You won't see
   the secret again — stash it locally just long enough to run Step 2.

Cloudflare docs: <https://developers.cloudflare.com/r2/api/s3/tokens/>

## Step 2 — Store the credentials in GCP Secret Manager

The deploy workflow expects five secrets in project `rgleaderboard`:

| Env var                 | Secret name              |
| ----------------------- | ------------------------ |
| `R2_ACCESS_KEY_ID`      | `r2-access-key-id`       |
| `R2_SECRET_ACCESS_KEY`  | `r2-secret-access-key`   |
| `R2_ACCOUNT_ID`         | `r2-account-id`          |
| `R2_BUCKET`             | `r2-bucket`              |
| `REBUILD_SHARED_SECRET` | `rebuild-shared-secret`  |

Create them with the values from Step 1 plus a fresh random string for
the rebuild secret:

```bash
PROJECT=rgleaderboard

for name in r2-access-key-id r2-secret-access-key r2-account-id r2-bucket rebuild-shared-secret; do
  gcloud secrets create "$name" \
    --project "$PROJECT" \
    --replication-policy=automatic \
    2>/dev/null || echo "  (already exists)"
done

# Populate them — pipe each value into stdin so it never appears in shell history.
printf '%s' 'AKIA...paste-from-cloudflare...'      | gcloud secrets versions add r2-access-key-id      --project "$PROJECT" --data-file=-
printf '%s' 'paste-secret-access-key'              | gcloud secrets versions add r2-secret-access-key  --project "$PROJECT" --data-file=-
printf '%s' 'paste-cloudflare-account-id'          | gcloud secrets versions add r2-account-id         --project "$PROJECT" --data-file=-
printf '%s' 'rgleaderboard'                        | gcloud secrets versions add r2-bucket             --project "$PROJECT" --data-file=-
printf '%s' "$(openssl rand -hex 32)"              | gcloud secrets versions add rebuild-shared-secret --project "$PROJECT" --data-file=-
```

Keep a copy of the `rebuild-shared-secret` value — you'll need it again
in Step 5 to configure the Scheduler header.

## Step 3 — Grant the Cloud Run runtime SA read access to the secrets

The workflow deploys with `--set-secrets`, which means the runtime
service account (the compute-default SA unless you override it) needs
`roles/secretmanager.secretAccessor` on each secret. Run:

```bash
PROJECT=rgleaderboard
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for name in r2-access-key-id r2-secret-access-key r2-account-id r2-bucket rebuild-shared-secret; do
  gcloud secrets add-iam-policy-binding "$name" \
    --project "$PROJECT" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet
done
```

The runtime SA also needs Firestore read access — it should already have
`roles/datastore.user` from the existing aggregate builder deploy. If
`gcloud run services proxy leaderboard-rebuild ...` returns a Firestore
permission error, add that role next.

## Step 4 — Initial deploy

You can either:

**A. Push to `main`** — any change under `firebase/scripts/**` triggers
`.github/workflows/deploy-rebuild-service.yml`, which runs the same
`gcloud run deploy --source firebase` command below. First-time
deploys work fine through the workflow as long as Steps 2 + 3 are done.

**B. Deploy from your laptop** (matches the workflow exactly, useful
for debugging deploy failures):

```bash
cd firebase
gcloud run deploy leaderboard-rebuild \
  --project rgleaderboard \
  --region us-central1 \
  --source . \
  --allow-unauthenticated \
  --command npm \
  --args run,start:cloud-run \
  --set-env-vars FIREBASE_PROJECT=rgleaderboard,NODE_ENV=production \
  --set-secrets R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest,R2_ACCOUNT_ID=r2-account-id:latest,R2_BUCKET=r2-bucket:latest,REBUILD_SHARED_SECRET=rebuild-shared-secret:latest \
  --cpu 1 --memory 512Mi \
  --concurrency 1 --min-instances 0 --max-instances 3 \
  --timeout 300s
```

Capture the resulting URL — you'll use it in Step 5:

```bash
gcloud run services describe leaderboard-rebuild \
  --project rgleaderboard --region us-central1 \
  --format='value(status.url)'
```

## Step 5 — Wire up the every-minute cron

```bash
export SERVICE_URL="https://leaderboard-rebuild-xxxxxxxxxx-uc.a.run.app"   # from Step 4
export REBUILD_SHARED_SECRET="paste-the-value-from-step-2"

bash firebase/scripts/setup-cloud-scheduler.sh
```

The script creates (or, on rerun, updates) a job named
`leaderboard-rebuild-cron` in `us-central1`, schedule `*/1 * * * *`,
posting to `${SERVICE_URL}/rebuild` with an `x-rebuild-secret` header.

Force an immediate run to confirm:

```bash
gcloud scheduler jobs run leaderboard-rebuild-cron \
  --project rgleaderboard --location us-central1
```

## Step 6 — Verify

```bash
# 1. Health check
curl -sSf "${SERVICE_URL}/health"

# 2. Manual rebuild (bypasses the scheduler — same auth header)
curl -sSf -X POST "${SERVICE_URL}/rebuild" \
  -H "x-rebuild-secret: ${REBUILD_SHARED_SECRET}"

# 3. Confirm the JSON blobs land in R2. Any S3-compat client works; e.g.
#    with the AWS CLI configured against the R2 endpoint:
aws s3 ls "s3://${R2_BUCKET}/leaderboards/" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# 4. Watch the Cloud Run logs while the cron fires
gcloud run services logs tail leaderboard-rebuild \
  --project rgleaderboard --region us-central1
```

If everything is green: the Scheduler job page in the GCP console should
show consecutive successful attempts (200 responses) and R2 object
`Last-Modified` timestamps should tick roughly every minute.

## Step 7 — (Future) Firestore-trigger for on-demand rebuilds

Deferred to v2. The idea: an Eventarc trigger on writes to the leaderboard
Firestore collection fires the same `POST /rebuild/{playlist}` endpoint
so blobs update within seconds of a score submission instead of waiting
up to a minute. Not implementing now because the 1-minute cron is
sufficient for the initial cutover and adds no extra moving parts.

Rough sketch for whoever picks it up:

```bash
gcloud eventarc triggers create leaderboard-rebuild-on-write \
  --project rgleaderboard \
  --location us-central1 \
  --destination-run-service leaderboard-rebuild \
  --destination-run-region us-central1 \
  --destination-run-path /rebuild \
  --event-filters "type=google.cloud.firestore.document.v1.written" \
  --event-filters "database=(default)" \
  --event-data-content-type "application/protobuf" \
  --service-account "${RUNTIME_SA}"
```

That will need `cloud-run-server.mjs` extended to accept CloudEvents
payloads and derive the playlist from the resource path — out of scope
here.

---

## Rollback

If the rebuild service misbehaves and you need to bail out fast:

```bash
# 1. Stop the every-minute cron (leaves the service alive so you can debug).
gcloud scheduler jobs pause leaderboard-rebuild-cron \
  --project rgleaderboard --location us-central1

# 2. Optional: roll the Cloud Run service back to a known-good revision.
gcloud run revisions list --service leaderboard-rebuild \
  --project rgleaderboard --region us-central1
gcloud run services update-traffic leaderboard-rebuild \
  --project rgleaderboard --region us-central1 \
  --to-revisions <good-revision>=100

# 3. Nuclear option: delete the service entirely. The frontend falls back
#    to the pre-existing Firestore path so nothing else breaks.
gcloud run services delete leaderboard-rebuild \
  --project rgleaderboard --region us-central1 --quiet
gcloud scheduler jobs delete leaderboard-rebuild-cron \
  --project rgleaderboard --location us-central1 --quiet
```

Resuming after a pause is `gcloud scheduler jobs resume leaderboard-rebuild-cron ...`.

## Cost sanity check

- Cloud Scheduler: 3 free jobs/month, so 1 job costs $0.
- Cloud Run: ~43k invocations/mo. Each rebuild is well under the 2M
  request + 400k GiB-s free tier at 512 MiB × ~2 s per invocation.
- R2: PUT is $4.50 / million; 43k/mo ≈ $0.20. Egress is free.

Comfortably free-tier for the MVP. Revisit if we widen the cron below
30 s or add per-playlist fan-out.
