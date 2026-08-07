# Firestore usage capture — one-time IAM setup

The 3-hour `firestore-aggregates` GitHub Actions workflow calls the GCP
Monitoring API v3 to record daily Firestore read/write/delete totals
into `read_stats_total/{yyyy-mm-dd}`. Auth reuses the existing
Workload-Identity-Federated service account (`GCP_SA_EMAIL`), but that
SA needs one extra IAM role granted **once per project**.

## Grant the SA `roles/monitoring.viewer`

The Monitoring API rejects `timeSeries.list` without this role.

```bash
PROJECT=rgleaderboard
SA_EMAIL="paste-the-value-of-the-GCP_SA_EMAIL-github-secret"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/monitoring.viewer" \
  --condition=None
```

Verify:

```bash
gcloud projects get-iam-policy "$PROJECT" \
  --flatten='bindings[].members' \
  --filter="bindings.members:${SA_EMAIL} AND bindings.role:roles/monitoring.viewer" \
  --format='value(bindings.role)'
```

Should print `roles/monitoring.viewer`.

## What the workflow writes

Every run pulls a 48-hour window from the Monitoring API and rewrites
today's and yesterday's docs. Re-fetching yesterday is intentional —
Cloud Monitoring lags real writes by ~3–15 minutes, so today's counter
isn't final until the following day.

Doc shape (`read_stats_total/2026-08-06`):

```json
{
  "date": "2026-08-06",
  "reads": 12345,
  "writes": 678,
  "deletes": 9,
  "source": "cloud-monitoring",
  "fetchedAt": "2026-08-06T12:34:56.000Z",
  "metricLagMinutes": 15
}
```

## Running locally

```bash
cd firebase
gcloud auth print-access-token >/dev/null   # sanity-check gcloud auth
npm run fetch:firestore-usage -- --project rgleaderboard          # dry-run
npm run fetch:firestore-usage -- --project rgleaderboard --apply  # writes
```

Without `--apply` the script logs what it *would* write but touches
nothing. The script is idempotent — a second run with identical
Monitoring data is a no-op (existing doc is diffed and skipped).

## Metric names

| Field   | GCP Monitoring metric type                                |
| ------- | --------------------------------------------------------- |
| reads   | `firestore.googleapis.com/document/read_count`            |
| writes  | `firestore.googleapis.com/document/write_count`           |
| deletes | `firestore.googleapis.com/document/delete_count`          |

All three are aligned to a `86400s` window with `ALIGN_SUM` per series
and `REDUCE_SUM` across series, then bucketed by UTC calendar day.

## Rollback

Nothing to roll back — the script writes to a dedicated collection
(`read_stats_total/`) that no other code depends on. To disable the
capture entirely without redeploying rules, remove the "Fetch Firestore
usage metrics" step from `.github/workflows/firestore-aggregates.yml`.
