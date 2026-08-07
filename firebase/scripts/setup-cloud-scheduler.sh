#!/usr/bin/env bash
# setup-cloud-scheduler.sh — idempotently create/update the Cloud Scheduler
# job that pokes the leaderboard rebuild service every minute.
#
# Requires:
#   - gcloud CLI authenticated as a principal with roles/cloudscheduler.admin
#     on the target project (assume the operator has already run
#     `gcloud auth login` and `gcloud config set project rgleaderboard`).
#   - env vars:
#       SERVICE_URL              https://leaderboard-rebuild-xxxxx.run.app
#       REBUILD_SHARED_SECRET    same value stored in GCP Secret Manager as
#                                rebuild-shared-secret, matched by
#                                cloud-run-server.mjs when validating the
#                                x-rebuild-secret header on POST /rebuild.
#
# Optional env overrides:
#       GCP_PROJECT   default rgleaderboard
#       GCP_REGION    default us-central1
#       JOB_NAME      default leaderboard-rebuild-cron
#       SCHEDULE      default "*/1 * * * *"  (every minute)
#
# Idempotent: reruns are safe. If the job already exists we patch it via
# `gcloud scheduler jobs update http` instead of creating a duplicate.

set -euo pipefail

: "${SERVICE_URL:?SERVICE_URL must be set (e.g. https://leaderboard-rebuild-xxx.run.app)}"
: "${REBUILD_SHARED_SECRET:?REBUILD_SHARED_SECRET must be set (matches the secret stored in Secret Manager)}"

GCP_PROJECT="${GCP_PROJECT:-rgleaderboard}"
GCP_REGION="${GCP_REGION:-us-central1}"
JOB_NAME="${JOB_NAME:-leaderboard-rebuild-cron}"
SCHEDULE="${SCHEDULE:-*/1 * * * *}"
TARGET_URL="${SERVICE_URL%/}/rebuild"

echo "==> Configuring Cloud Scheduler job '$JOB_NAME' in $GCP_PROJECT/$GCP_REGION"
echo "    schedule: $SCHEDULE"
echo "    target:   POST $TARGET_URL"

# Check whether the job already exists — gcloud exits non-zero if not found.
if gcloud scheduler jobs describe "$JOB_NAME" \
      --project "$GCP_PROJECT" \
      --location "$GCP_REGION" \
      >/dev/null 2>&1; then
  echo "==> Job exists — updating in place"
  gcloud scheduler jobs update http "$JOB_NAME" \
    --project "$GCP_PROJECT" \
    --location "$GCP_REGION" \
    --schedule "$SCHEDULE" \
    --uri "$TARGET_URL" \
    --http-method POST \
    --update-headers "x-rebuild-secret=${REBUILD_SHARED_SECRET},content-type=application/json" \
    --time-zone "Etc/UTC" \
    --attempt-deadline "60s" \
    --quiet
else
  echo "==> Job not found — creating"
  gcloud scheduler jobs create http "$JOB_NAME" \
    --project "$GCP_PROJECT" \
    --location "$GCP_REGION" \
    --schedule "$SCHEDULE" \
    --uri "$TARGET_URL" \
    --http-method POST \
    --headers "x-rebuild-secret=${REBUILD_SHARED_SECRET},content-type=application/json" \
    --time-zone "Etc/UTC" \
    --attempt-deadline "60s" \
    --description "Every-minute rebuild of leaderboard JSON blobs (POST /rebuild on ${SERVICE_URL})" \
    --quiet
fi

echo "==> Done. Recent runs:"
gcloud scheduler jobs describe "$JOB_NAME" \
  --project "$GCP_PROJECT" \
  --location "$GCP_REGION" \
  --format="value(state,lastAttemptTime,status.code)"

echo ""
echo "Tip: force an immediate run with:"
echo "  gcloud scheduler jobs run $JOB_NAME --project $GCP_PROJECT --location $GCP_REGION"
