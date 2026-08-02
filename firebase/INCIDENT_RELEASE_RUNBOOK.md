# ATLAS 16.0 release and incident runbook

This is the approved forced mid-event upgrade path. Use one reviewed release
window. Stop if a device is missing, a conflict is unresolved, scoring changes,
the rollback snapshot is incomplete, or any test fails.

## 1. Archive

```bash
npm ci
npm test
npm run snapshot:production -- --project rgleaderboard
```

Copy the new `.snapshots/<timestamp>-rgleaderboard` directory to a second safe
location. Check `manifest.json` hashes and keep the rules and index metadata.
The snapshot command is read-only.

## 2. Freeze

**APPROVAL-GATED PRODUCTION MUTATION:** pause create, join, approve, kick,
leave, transfer, rename, and disband. Set the agreed maintenance flag only
after the release owner approves the exact project and value.

Take another read-only snapshot after the freeze. If its counts or hashes moved,
restart the archive step.

## 3. Dry run

```bash
node scripts/plan-migrations.mjs \
  --fixture <fresh-snapshot.json> \
  --output .migration-plans/atlas-16.json
shasum -a 256 .migration-plans/atlas-16.json
npm run apply:migrations -- --plan .migration-plans/atlas-16.json
```

The last command is a local dry run. It must not request credentials or contact
Firebase.

## 4. Review conflicts

Review `blockers`, `unresolvedConflicts`, every destructive operation, manual
leaderboard rows, score totals, member baselines, directory shards, and every
name, tag, member, and device lock. Record selected leaderboard conflicts and
approved operation IDs in a separate approvals file.

Do not auto-resolve player, device, name, or tag conflicts. Fix the source,
archive again, and make a new plan.

## 5. Roll out

1. Publish the tested websites and ATLAS 16.0 compatibility client.
2. Verify the update URLs serve 16.0 and the two websites load normally.
3. **APPROVAL-GATED PRODUCTION MUTATION:** enable compatibility writes. This
   forced rollout does not wait for passive adoption; the final rules and
   `minVersion` block older writers.
4. **APPROVAL-GATED PRODUCTION MUTATION/DELETION:** run the apply command with
   the exact project, project confirmation, plan hash, and approvals file.
5. Take a read-only post-migration snapshot and run:

```bash
npm run verify:baseline -- <before-manifest> <after-manifest>
```

6. Require exact roster, score, baseline, directory, and reservation parity.
7. **APPROVAL-GATED PRODUCTION MUTATION:** deploy indexes, wait until ready,
   deploy final rules, enable reservations, set `minVersion` to `16.0`, disable
   compatibility writes, and unfreeze actions.

Never combine steps 4 and 7 under one approval.

## 6. Smoke test

**APPROVAL-GATED PRODUCTION MUTATIONS:** with test accounts only, run create,
join, approve, match sync, role change, transfer, leave, kick, rename, and
admin disband. Confirm notices, deterministic leaderboard IDs, directory
shards, and released locks. Delete test data only under the same approval.

Read-only checks: open each leaderboard playlist, load a cold and warm popup,
reopen the clan panel, compare both sites, and verify old/new clan rows show the
same names, MMR, baselines, and scores.

## 7. Monitor

For one hour, then again at 24 hours, review denied writes, missing locks,
duplicate memberships, score drift, listener errors, and the operation targets
in `tests/fixtures/atlas-contract.json`.

Roll back if normal actions fail, parity changes, duplicates appear, or reads
or writes exceed twice a documented target.

## 8. Roll back

1. **APPROVAL-GATED PRODUCTION MUTATION:** freeze structural actions and disable
   reservations.
2. **APPROVAL-GATED PRODUCTION MUTATION:** restore the reviewed rules, indexes,
   minimum version, and compatibility setting.
3. Keep migrated directory and lock documents. Do not delete them during the
   first rollback.
4. **APPROVAL-GATED PRODUCTION MUTATION/DELETION:** restore or remove data only
   from a new dry-run plan with exact hashes, preconditions, and approvals.
5. Take another read-only snapshot and verify roster, scoring, baselines,
   directory, locks, counts, and budgets.
6. Keep the freeze on until every difference is explained.
