# ATLAS Firebase workspace

This folder contains the Firestore rules, indexes, emulator tests, snapshots,
ATLAS 16.0 migration tools, and the approved ATLAS 16.1 bridge planner.

## Safety

- The default Firebase project is `demo-rgleaderboard`.
- Tests use the local Firestore emulator.
- `plan:migrations` reads local JSON only.
- `plan:rollout-bridge` reads one local snapshot and writes one local plan.
- `apply:migrations` is a local dry run unless `--apply` and every production
  gate are present.
- Snapshot output, plans, approvals, and checkpoints are ignored by Git.
- Access tokens are held in memory and are never printed or saved.
- No script deploys rules, indexes, websites, or ATLAS.
- A mid-event apply is allowed only through the approved forced-upgrade
  runbook, with a fresh snapshot and reviewed conflict plan.

Firestore rules can enforce document shape, deterministic IDs, uniqueness
locks, and atomic parity. They do not prove which player owns a role. Player
role authorization remains an honor-system client check because there is no
trusted server or billing-backed function.

## Install and test

Node 20 and Java 21 are expected.

```bash
cd firebase
npm ci
npm run test:rules
npm run test:migrations
npm run test:snapshots
npm run test:contracts
```

`tests/fixtures/atlas-contract.json` is the sanitized cross-repository
contract. Contract tests use `../../rgleaderboard` and
`../../RG_Clan_leaderboard` locally. CI can set `MAIN_SITE_PATH` and
`CLAN_SITE_PATH` to coordinated checkouts.

The fixture documents ceilings for active leaderboard load, cold and warm
popup cache, match sync, clan reopen, structural actions, and five concurrent
member matches. With `useLeaderboardCache`, cold popup cache is 2 reads
(config + aggregate). Snapshot manifests record the same operation model.
See `docs/leaderboard-cache-rollout.md` for enablement and rollback.

Rules have two explicit emulator modes:

```bash
npm run test:rules:compatibility
npm run test:rules:final
```

Both modes test the same deployable `firestore.rules`. Compatibility mode sets
`admin/migration.allowLegacyClanWrites` to `true`. Final mode sets it to
`false`. A missing migration control document is final mode.

## Rules contract

Public reads are limited to paths used by ATLAS and the two websites:

- `leaderboard`, `script_submissions`, `iconKey`, and `atlas_config`
- `leaderboard_cache` (trusted playlist aggregates + iconKey manifest)
- `events`, `clans`, `clans_directory`, and `clan_notices`
- `clan_name_keys`, `clan_tag_keys`, `clan_memberships`, and `clan_devices`
- `admin/blacklist` and `admin/clanPerms`

Unknown paths and `match_audits` are denied. Config, event, icon, manual
leaderboard, and admin writes require one of the configured admin emails.
Sourced leaderboard IDs are `{sourceUserId}_{playlist}`.

New clan documents use member maps, `memberIds`, `deviceIds`, `lockVersion: 1`,
and version 16.0 or newer. The clan checks every member lock. Each member lock
checks all known device locks, up to five devices per member. This transitive
check keeps name, tag, member, device, and directory parity within Firestore's
rule access limits.

Legacy clan documents stay readable. While the compatibility flag is true,
ATLAS 16.1 can update an unmigrated legacy document. A document with
`lockVersion: 1` can never be changed back to the legacy shape.

## Trusted leaderboard cache aggregates

`leaderboard_cache/{1v1,2v2,3v3}` and `leaderboard_cache/iconKey` are built by
a dry-run-first script. Clients may read; only admins/service accounts write.
Rows are compact (`uid`, `name`, `mmr`, `rank`) and never freeze live streaks —
ATLAS still reads `script_submissions` for opponent streaks.

```bash
# Offline help
npm run build:leaderboard-cache -- --help

# Dry run against production (no writes)
npm run build:leaderboard-cache -- --project rgleaderboard

# Apply after review
npm run build:leaderboard-cache -- --project rgleaderboard --apply
```

Unchanged `sourceHash` values skip the write. Oversized docs are refused.
GitHub Actions workflow `.github/workflows/firestore-aggregates.yml` runs every
3 hours with Workload Identity Federation (`GCP_WIF_PROVIDER`,
`GCP_SA_EMAIL`). Manual dispatch defaults to dry-run.

Rollout flag on `atlas_config/hud`:

- `useLeaderboardCache: true` — ATLAS prefers the aggregate (1 read) when fresh
- omit/false — ATLAS keeps the direct `leaderboard` query fallback

Rollback: set `useLeaderboardCache` false (or delete the field). Aggregates can
also be left stale; clients fall back when `builtAt` is older than
`cacheRefreshHours`.

## Read-only production snapshot

Help and the default command are offline:

```bash
npm run snapshot:production
npm run snapshot:production -- --help
```

An explicit project is required for a read-only snapshot:

```bash
npm run snapshot:production -- --project rgleaderboard
```

The command gets a token from `gcloud auth print-access-token`, sends only GET
requests, and writes a private folder under `.snapshots/`. The snapshot includes
current clan notices so a bridge plan can use exact overwrite or missing
preconditions. The manifest records SHA-256 hashes, byte sizes, document counts,
rules metadata, and index metadata.

Compare pre- and post-change snapshots locally:

```bash
npm run verify:baseline -- \
  .snapshots/<before>/manifest.json \
  .snapshots/<after>/manifest.json
```

## Build a local migration plan

The default fixture is sanitized:

```bash
npm run plan:migrations
```

Write a reviewed plan file without overwriting an existing file:

```bash
mkdir -p .migration-plans
node scripts/plan-migrations.mjs \
  --fixture <local-snapshot-or-fixture.json> \
  --output .migration-plans/atlas-16.json
shasum -a 256 .migration-plans/atlas-16.json
```

The planner:

- keeps manual leaderboard rows untouched;
- carries sourced-row cosmetics into deterministic IDs;
- reports duplicate choices and all rekeys/deletes;
- preserves clan scoring, `memberStats`, and legacy/per-member baselines;
- creates member maps, lock records, and one directory shard per clan;
- uses version 16.0 and never invents missing device IDs;
- recommends an established clan by oldest `createdAt`, then stable ID;
- blocks clans with invalid final-rule shapes, missing devices, more than five
  devices per member, or unresolved ownership conflicts.

The sanitized device-conflict fixture represents the audited established-clan
versus newer-test-clan case without storing production names or IDs.

## Build the approved ATLAS 16.1 bridge plan

This planner is only for the approved bridge: keep the established clan,
disband the newer one-member test clan, leave the newer leaderboard duplicate
for later, keep reservations off, enable legacy writes, freeze structural clan
actions, and require ATLAS 16.1. Do not put a real clan ID or name in version
control.

The default and help commands are offline:

```bash
npm run plan:rollout-bridge
npm run plan:rollout-bridge -- --help
```

Use one fresh local snapshot and all required arguments:

```bash
mkdir -p .migration-plans .migration-approvals
npm run plan:rollout-bridge -- \
  --snapshot .snapshots/<fresh-snapshot>/snapshot.json \
  --disband-clan-id '<approved-newer-test-clan-id>' \
  --expect-clan-name '<exact-approved-clan-name>' \
  --min-version 16.1 \
  --output .migration-plans/atlas-16.1-bridge.json

shasum -a 256 .migration-plans/atlas-16.1-bridge.json
npm run apply:migrations -- \
  --plan .migration-plans/atlas-16.1-bridge.json
```

The last command is the offline dry run. Review the exact hash, `summary`,
`rollbackValues`, every precondition, and every ID in
`approval.operationIds`. Confirm `leaderboardOperations` and
`otherClanOperations` are both zero.

Create `.migration-approvals/atlas-16.1-bridge.json` locally. Copy every ID
from `approval.operationIds`; omitting any one blocks apply:

```json
{
  "schemaVersion": 1,
  "project": "rgleaderboard",
  "planSha256": "<exact-64-character-plan-hash>",
  "approvedOperationIds": [
    "<every-operation-id-from-the-reviewed-plan>"
  ],
  "conflictResolutions": []
}
```

## Approvals file

Production apply needs a separate local approvals file. It must contain the
exact plan hash and project. Every destructive operation ID must be listed.

```json
{
  "schemaVersion": 1,
  "project": "rgleaderboard",
  "planSha256": "<64-character-plan-hash>",
  "approvedOperationIds": [
    "op-reviewed-rekey",
    "op-reviewed-delete"
  ],
  "conflictResolutions": [
    {
      "conflictId": "leaderboard-reviewed-conflict",
      "selectedId": "reviewed-source-document"
    }
  ]
}
```

Clan ownership conflicts are manual-only. Selecting one in an approvals file
does not authorize automatic disband or member removal. Resolve the source
decision, take a fresh snapshot, and produce a new conflict-free plan.

## Apply an approved plan

This command is always local and offline:

```bash
npm run apply:migrations -- --plan .migration-plans/atlas-16.json
```

Production apply requires every gate:

```bash
npm run apply:migrations -- \
  --plan .migration-plans/atlas-16.json \
  --apply \
  --project rgleaderboard \
  --confirm-project rgleaderboard \
  --approved-plan-sha256 <exact-plan-hash> \
  --approvals .migration-approvals/atlas-16.json
```

Before requesting a token, the tool verifies:

1. `--apply` is present.
2. `--project` and `--confirm-project` match exactly.
3. The approved hash matches the exact plan file bytes.
4. The approvals file matches the hash and project.
5. No blocker or unresolved conflict remains.
6. Every destructive operation has explicit approval and an expected document
   hash or missing-document precondition.

Writes use batches of at most 20. Each document is read and checked before its
write, each commit uses the current server update time, and every batch is read
back. Completed operation IDs are saved under `.migration-state/`. A retry
skips already verified writes and resumes the remaining batches.

## Exact approved bridge rollout

Use `INCIDENT_RELEASE_RUNBOOK.md` for the approval gates and command checklist.

1. Publish and verify ATLAS 16.1 and both websites.
2. Capture a fresh rollback snapshot in two places. It must include
   `clan_notices`.
3. Generate the bridge plan with the exact approved clan ID and name. Record
   the hash and run the offline apply dry run.
4. Review every destructive operation, precondition, rollback value, and
   approval ID. The plan must not touch leaderboard rows or another clan.
5. Create the local approvals file with the exact plan hash and every operation
   ID.
6. **APPROVAL-GATED LIVE ACTION:** deploy the tested compatibility rules.
7. Run the gated apply command:

```bash
npm run apply:migrations -- \
  --plan .migration-plans/atlas-16.1-bridge.json \
  --apply \
  --project rgleaderboard \
  --confirm-project rgleaderboard \
  --approved-plan-sha256 <exact-plan-hash> \
  --approvals .migration-approvals/atlas-16.1-bridge.json
```

8. Take a read-only post-bridge snapshot. Verify the control documents, frozen
   structural permissions, notices, legacy directory, and one approved clan
   deletion. Confirm leaderboard rows and every other clan are unchanged.
9. Keep `useClanReservations=false`, all structural actions frozen,
   `allowLegacyClanWrites=true`, and `minVersion=16.1`.

The final data migration remains blocked until members with missing device
identities open ATLAS 16.1 and self-link. Do not enable reservations, disable
legacy writes, unfreeze structural actions, or run the ATLAS 16.0 data
migration before those devices are present in a fresh snapshot.

## Exact rollback

1. Freeze all structural clan actions.
2. Disable clan reservations.
3. Restore the reviewed pre-rollout rules and indexes from version control and
   the snapshot metadata.
4. Restore the previous `admin/blacklist.minVersion`.
5. Set `admin/migration.allowLegacyClanWrites` to `true` only if ATLAS 16.1
   compatibility writes are needed during rollback.
6. Keep new lock and directory documents. Do not mass-delete them.
7. Restore data only from the verified pre-change snapshot with a separately
   reviewed plan and approvals file.
8. Take a fresh snapshot and compare counts, rosters, scoring, baselines, and
   operation budgets.
9. Leave actions frozen if parity differs. Fix the plan and rerun emulator tests
   before another rollout.
