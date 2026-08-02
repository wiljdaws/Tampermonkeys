# ATLAS 16.0 clan integrity rollout

This is the approved forced mid-event migration. Use
`INCIDENT_RELEASE_RUNBOOK.md` as the command checklist.

## Stop conditions

Stop before production apply if any item is true:

- The current standings and rollback snapshot are not archived in two places.
- The pre-change snapshot or manifest is missing.
- A clan member has no known device ID.
- A member has more than five known device IDs and needs a reviewed cleanup.
- A name, tag, player, or device conflict is unresolved.
- A destructive operation is absent from the separate approvals file.
- The plan hash, approvals hash, project, and confirmation do not match.
- Compatibility, final, migration, or snapshot tests fail.

Firestore rules enforce shape and lock parity. They do not authenticate player
roles. An authenticated website admin is required for disband.

## Dry run

```bash
npm run test:rules
npm run test:migrations
npm run test:snapshots
npm run snapshot:production -- --project rgleaderboard

mkdir -p .migration-plans
node scripts/plan-migrations.mjs \
  --fixture <fresh-local-snapshot.json> \
  --output .migration-plans/atlas-16.json
shasum -a 256 .migration-plans/atlas-16.json

npm run apply:migrations -- \
  --plan .migration-plans/atlas-16.json
```

Review all of these:

- `unresolvedConflicts`
- `blockers`
- `blockedClanIds`
- `missingDeviceMembers`
- every `destructive: true` operation
- every expected document hash and update time
- manual leaderboard preservation
- clan scoring, `memberStats`, and event baselines
- directory, name, tag, membership, and device outputs

The dry run does not request a credential or contact Firebase.

## Production order

1. Publish ATLAS 16.0 and compatible websites with reservations off.
2. Verify the update URL and both websites before forcing older writers off.
3. Set `admin/migration.allowLegacyClanWrites` to `true`.
4. Freeze all structural clan actions.
5. Take and protect a fresh snapshot.
6. Generate the final plan from that snapshot.
7. Record the exact SHA-256 and create the separate approvals file.
8. Run the gated apply command shown in `README.md`.
9. If interrupted, rerun the same command. Checkpoints resume verified batches.
10. Take a post-change snapshot and run `verify:baseline`.
11. Require exact roster, score, baseline, directory, and lock parity.
12. Deploy the additive indexes and wait for `playlist + wins DESC` to finish.
13. Deploy `firestore.rules`.
14. Enable reservations.
15. Set `admin/blacklist.minVersion` to `16.0`.
16. Set `admin/migration.allowLegacyClanWrites` to `false`.
17. Smoke-test all normal clan actions and authenticated admin disband.
18. Unfreeze actions.
19. Monitor failures and operation counts for one hour and 24 hours.

The apply tool reads and checks each expected document, commits at most 20
operations at a time, saves local progress, and reads every batch back. It
never prints or stores the access token.

## Conflict handling

The planner recommends the established clan using oldest `createdAt`, then
stable clan ID. A recommendation is not approval.

Clan ownership and shared-device conflicts are manual-only. The apply tool
refuses them even when a selected clan appears in the approvals file. Make the
reviewed source-data decision, take another snapshot, and generate a new plan.

Leaderboard duplicate choices may be resolved in the approvals file. Every
resulting rekey and deletion still needs its operation ID in
`approvedOperationIds`.

## Rollback

1. Freeze structural clan actions.
2. Disable reservations.
3. Restore the reviewed pre-change rules and indexes.
4. Restore the previous minimum version.
5. Turn compatibility writes back on only if needed for ATLAS 16.0.
6. Keep migrated lock and directory documents in place.
7. Do not perform cleanup or restore writes without a new reviewed plan, exact
   hash, approvals file, and expected document preconditions.
8. Take another snapshot and compare it with the pre-change manifest.
9. Verify rosters, scoring, event baselines, counts, and operation budgets.
10. Keep actions frozen if any unexpected difference remains.
