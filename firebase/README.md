# ATLAS Firebase workspace

This folder contains the Firestore rules, indexes, emulator tests, snapshots,
and ATLAS 16.0 migration tools for `rgleaderboard`.

## Safety

- The default Firebase project is `demo-rgleaderboard`.
- Tests use the local Firestore emulator.
- `plan:migrations` reads local JSON only.
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
member matches. Snapshot manifests record the same operation model.

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
requests, and writes a private folder under `.snapshots/`. The manifest records
SHA-256 hashes, byte sizes, document counts, rules metadata, and index metadata.

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

## Exact rollout

Use `INCIDENT_RELEASE_RUNBOOK.md` for the approval gates and command checklist.

1. Capture current standings and the full rollback snapshot in two places.
2. Deploy compatibility-capable ATLAS 16.1 and both websites. Keep clan
   reservations off.
3. Verify the 16.1 update URL and both websites. This approved forced rollout
   uses the final rules and `minVersion` instead of waiting for passive
   adoption.
4. Set `admin/migration.allowLegacyClanWrites` to `true`.
5. Freeze create, rename, join, approve, kick, leave, transfer, and disband.
6. Take a fresh snapshot and copy it to a second protected location.
7. Generate the plan, record its exact hash, and review conflicts, blockers,
   destructive paths, rules, indexes, and expected operation counts.
8. Create the separate approvals file. Do not approve unresolved clan ownership
   or missing-device cases.
9. Run the gated apply command once. If interrupted, rerun the same command
   with the same plan, hash, and approvals.
10. Take a second snapshot and run `verify:baseline`. Require exact clan roster,
    scoring, baseline, directory, and lock parity.
11. Deploy `firestore.indexes.json`, including `playlist + wins DESC`, and wait
    until the index is ready.
12. Deploy the reviewed `firestore.rules`.
13. Enable clan reservations, set `admin/blacklist.minVersion` to `16.1`, and
    set `admin/migration.allowLegacyClanWrites` to `false`.
14. Smoke-test leaderboard sync, clan create, join, approve, rename, role
    change, leave, kick, and authenticated admin disband.
15. Unfreeze structural actions and monitor failures and operation counts for
    one hour and 24 hours.

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
