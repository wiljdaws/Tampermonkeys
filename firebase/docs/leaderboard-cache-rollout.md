# Leaderboard cache rollout

## What ships

Trusted aggregates at `leaderboard_cache/{1v1,2v2,3v3}` plus
`leaderboard_cache/iconKey`, rebuilt every ~3 hours by
`.github/workflows/firestore-aggregates.yml`.

ATLAS cold popup cache:

| Path | Reads |
| --- | --- |
| Aggregate on (`useLeaderboardCache`) | ~1–2 (config + cache doc; config often memoized) |
| Direct query fallback | ~101 (config + top 100 rows) |

Live streak snipes still use `script_submissions/{uid}` — streaks are never
frozen into the aggregate.

## Prerequisites

1. Deploy Firestore rules that allow public read / admin write on
   `leaderboard_cache/{playlist}`.
2. Configure GitHub secrets `GCP_WIF_PROVIDER` and `GCP_SA_EMAIL` for a service
   account that can read `leaderboard`/`iconKey` and write `leaderboard_cache`.
3. Shadow dry-run: `npm run build:leaderboard-cache -- --project rgleaderboard`
4. Apply once: add `--apply`, then spot-check docs in console.

## Enable

1. **Dev / shadow:** leave `atlas_config/hud.useLeaderboardCache` unset/false.
   Confirm aggregates match playlist queries (same uid/mmr/rank order).
2. **Production:** set `atlas_config/hud.useLeaderboardCache` to `true`.
3. Watch Firebase usage for cold popup reads dropping toward 1–2 per mode.

## Rollback

1. Set `atlas_config/hud.useLeaderboardCache` to `false` (immediate).
2. Optional: pause the GitHub Actions workflow.
3. Aggregates can remain; they are unused when the flag is off.

## Monitoring

- Workflow run history every 3h; failed runs leave previous aggregates in place.
- ATLAS debug: look for `leaderboard cache aggregate` vs
  `leaderboard cache refreshed` log lines.
- Budget contract: `operationBudgets.coldPopupCache.reads` is `2` when the
  aggregate path is the documented default.
