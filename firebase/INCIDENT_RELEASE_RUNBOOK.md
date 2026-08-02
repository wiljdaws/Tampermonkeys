# ATLAS 16.1 release and incident runbook

This is the approved forced mid-event upgrade path. Use one reviewed release
window. Stop if an approved-clan member identity is missing, a conflict is
unresolved, scoring changes, the rollback snapshot is incomplete, or any test
fails.

## 1. Archive

```bash
npm ci
npm test
npm run snapshot:production -- --project rgleaderboard
```

The snapshot must include `clan_notices`. Copy the new
`.snapshots/<timestamp>-rgleaderboard` directory to a second safe location.
Check `manifest.json` hashes and keep the rules and index metadata. The snapshot
command is read-only.

## 2. Prepare the bridge

Publish and verify ATLAS 16.1 and both websites. Keep clan reservations off.
Do not make standalone flag or clan edits. The reviewed bridge plan applies the
freeze, compatibility setting, minimum version, notices, directory update, and
approved disband together.

Take a fresh read-only snapshot immediately before planning and copy it to a
second protected location. If its counts or hashes move, start again.

## 3. Dry run

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

The last command is a local dry run. It must not request credentials or contact
Firebase. The planner also rejects apply, deploy, project, and mutation
arguments.

## 4. Review and approve

Review the plan's exact hash, `summary`, `rollbackValues`, every operation,
every hash and update-time precondition, and every ID in
`approval.operationIds`.

Confirm all of these before continuing:

- the expected clan name matches exactly;
- the approved clan appears exactly once in `clans_directory/index`;
- one notice is planned for every member;
- every operation is destructive and approval-required;
- `leaderboardOperations` and `otherClanOperations` are zero;
- no reservation lock or per-clan directory shard exists for the approved clan.

Create `.migration-approvals/atlas-16.1-bridge.json` locally:

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

Missing one operation ID blocks the apply. If the source changed, a member
identity is missing, or reservation state exists, take a new snapshot and use
the full admin cleanup path instead.

## 5. Roll out

1. Verify the update URL still serves 16.1 and both websites load.
2. **APPROVAL-GATED LIVE DEPLOY:** deploy the tested compatibility rules:

```bash
npx firebase deploy --only firestore:rules --project rgleaderboard
```

3. **APPROVAL-GATED PRODUCTION MUTATION/DELETION:** apply the exact reviewed
   bridge:

```bash
npm run apply:migrations -- \
  --plan .migration-plans/atlas-16.1-bridge.json \
  --apply \
  --project rgleaderboard \
  --confirm-project rgleaderboard \
  --approved-plan-sha256 <exact-plan-hash> \
  --approvals .migration-approvals/atlas-16.1-bridge.json
```

4. If interrupted, rerun the same command with the same plan, hash, and
   approvals.
5. Take a read-only post-bridge snapshot.
6. Confirm `admin/migration.allowLegacyClanWrites=true`,
   `admin/blacklist.minVersion=16.1`, `events/current.useClanReservations=false`,
   and all nine structural permissions are false.
7. Confirm every approved member has an `admin_disbanded` notice, the approved
   clan is gone from `clans` and the legacy directory, and every other clan and
   leaderboard row is unchanged.

The final data migration remains blocked until members with missing device
identities open ATLAS 16.1 and self-link. Until a fresh snapshot shows those
devices, do not enable reservations, disable legacy writes, unfreeze structural
actions, or run the full migration.

## 6. Smoke test

Open each leaderboard playlist, load a cold and warm popup, reopen the clan
panel, and compare both sites. Verify the approved member sees the disband
notice and older clients are blocked by the 16.1 minimum.

Structural actions should remain visibly frozen. Do not create a replacement
test clan or exercise reservation-backed actions during this bridge.

## 7. Monitor

For one hour, then again at 24 hours, review denied writes, score drift,
listener errors, notice handling, and the operation targets in
`tests/fixtures/atlas-contract.json`.

Roll back if leaderboard sync fails, unexpected clan changes appear, or reads
or writes exceed twice a documented target.

## 8. Roll back

1. **APPROVAL-GATED PRODUCTION MUTATION:** freeze structural actions and disable
   reservations.
2. **APPROVAL-GATED PRODUCTION MUTATION:** restore the three reviewed control
   documents from the bridge plan's `rollbackValues`.
3. **APPROVAL-GATED PRODUCTION MUTATION:** restore the removed clan and legacy
   directory document only from `rollbackValues` with a new plan, exact current
   preconditions, hash, and approvals.
4. Restore overwritten notices only if the release owner approves their saved
   rollback values.
5. Restore the reviewed pre-bridge rules if compatibility rules are part of the
   rollback decision.
6. Take another read-only snapshot and verify every difference.
7. Keep structural actions frozen until the rollback is complete.
