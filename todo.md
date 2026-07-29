# ATLAS post-event TODO

Note to self. Feed this file to Claude after the current Clan Clash Cup
event ends. Everything below is deferred because it would break users
still on 13.5 or corrupt live event data.

## When to start

- Confirm `events/current.endTime` has passed.
- Confirm final Clash standings are recorded (screenshot or Firestore
  export of every `clans/{id}` doc while data is still in the old shape).
- Nobody actively grinding for the current event.

## Coordination requirements

- The companion site at `wiljdaws.github.io/RG_Clan_Leaderboard/` reads
  the same Firestore. Its `js/scoring.js` is a line-for-line port of
  ATLAS's clan scoring math. Update the site in the same release window
  or standings on the site will diverge from standings in the HUD.
- Bumping `admin/blacklist.minVersion` is the enforcement lever. Old
  clients hit the update nag on boot. Version gate is spoofable, so
  50-person trust assumption still applies.
- Migration script needs Firebase admin SDK creds. Pal has these.

## Post-event work, in order

### Phase A — bridge release (ATLAS 13.7)

Dual-write everything. Read new shape if present, fall back to old.

Files:
- `rg_hud.user.js` clan writes: 1629 (updateMyClanMMR), 2124 (baseline),
  2985 (requestJoin), 3021 (approveRequest), 3056 (kickMember), 3149
  (setMemberRole), 3244 (transferLeadership), 3442 (leaveClan).
- `rg_hud.user.js` clan reads: 2429 (onSnapshot), 2479 (loadClanData),
  2486 (own clan refresh).
- Companion site `js/scoring.js`: same dual-read.

Bump `minVersion` to 13.7 in `admin/blacklist`. Wait 3-5 days.

### Phase B — schema changes to run in the migration script

Node + firebase-admin, idempotent, safe to re-run.

1. **`clans/{id}.members[]` → `clans/{id}.members{}` map keyed by uid.**
   Kills the whole-array clobber class (H3, M9). Enables atomic
   `updateDoc({[`members.${uid}.mmr`]: n})`.
2. **Move `eventBaseline` INTO the member row.**
   `clans/{id}.eventBaseline{uid: mmr}` → `members.{uid}.eventBaseline`.
   Baseline lives on the member; disappears when they leave; no
   cross-user clobber (H2).
3. **`clans_directory/index` singleton → `clans_directory/{clanId}`.**
   One doc per clan. Kills the race where two clients rebuild the whole
   index concurrently (C4). Site's browse view uses `getDocs` on the
   collection.
4. **`leaderboard/{autoId}` → `leaderboard/{sourceUserId}`.**
   Kills the query-then-patch-or-add dance at rg_hud.user.js:1510-1529.
   Consolidate: for each unique sourceUserId, keep freshest doc, rekey
   to `leaderboard/{sourceUserId}`, delete auto-ID original.
5. **`admin/blacklist.deviceHashes[]` → `admin_blacklist/{hash}` subcoll.**
   Rules do doc-exists check per write, O(1) not O(n). Client never
   reads the array anyway (only checks `minVersion` at line 1122).
   Safe to do earlier if wanted.
6. **`clan_notices/{userId}` → `users/{uid}/notices/{noticeId}`.**
   Not a data-corruption fix, an access-control fix. Requires the same
   dual-read bridge as members. Rules then require writer to be an
   authorized officer of the target's ex-clan. Only meaningful with
   auth (see Phase D).

### Phase C — ATLAS 13.8, drop the bridge

Remove old-shape writes. Firestore rules reject
`request.resource.data.members is list`. `versionNum < 13.7` also
rejected once we have >95% updated clients.

### Phase D — Firestore rules tightening (parallel to A-C)

Even without CF auth, these help:
- `clans/{id}`: `leaderId` immutable except by current leader.
  `request.resource.data.leaderId in [null, resource.data.leaderId, request.auth.uid]`.
- `script_submissions/{playerId}` and `leaderboard/{playerId}`:
  `request.resource.data.sourceUserId == playerId`. Forces doc key to
  match the claim. Cheap identity binding.
- `admin/blacklist`: read-only except by admin.
- `versionNum is number && versionNum >= 13.7`.
- `clans/{id}.joinRequests.size() < 50` to cap DoS surface.

### Phase E — optional, only if griefing becomes real

Cloud Function auth for leaderboard writes and clan mutations. Uses
Firebase ID token from the game's own auth. The endpoint at
`v0304_player/nickname` already does this — same pattern.

Don't do this until abuse is observed. It's the right architecture but
weeks of work for a 50-person community that mostly self-polices.

## Verification checklist post-migration

- [ ] No `members: [...]` array writes visible in Firestore for 24h.
- [ ] Every active clan has `members.{uid}.eventBaseline` populated
      (for the CURRENT event; old events not backfilled).
- [ ] `leaderboard` collection has zero duplicate `sourceUserId` values.
- [ ] `clans_directory` collection has one doc per clan; singleton
      `/index` is either deleted or ignored.
- [ ] Companion site loads clan standings and totals match the HUD.
- [ ] Clan Clash contribution math matches between HUD and site to the
      MMR unit.
- [ ] `admin/blacklist.minVersion == 13.7` (or whatever we shipped).

## v13.6 followups (not blocking, do when convenient)

- **Firestore rules for `match_audits/{autoId}`**: this new collection was
  added in 13.6 as write-only, append-only, non-breaking. The client
  gracefully degrades if writes are rejected. To actually populate the
  collection, add rules like:

  ```
  match match_audits/{doc} {
      allow create: if request.resource.data.sourceUserId is string
                    && request.resource.data.versionNum is number
                    && request.resource.data.versionNum >= 13.6
                    && !("clientTs" in resource.data || false);
      allow read: if false;   // dashboard reads only via admin SDK
      allow update, delete: if false;
  }
  ```
  Cost is one small doc per player per ranked match end. For a 50-user
  community that's maybe 500-2000 docs/day. Trivial storage.

- **Rules for existing `admin/blacklist.deviceHashes[]` migration** (S5 in
  the schema section below) — safe to do independently, client doesn't
  read `deviceHashes` anyway. Split into `admin_blacklist/{hash}` docs so
  rules evaluate O(1) instead of walking the whole array.

## Tier 2 — Donation unlocks (talk to Pal first, then ~1 weekend build)

Real payment → real unlock. Unspoofable signal. Best-precedented feature to add.

### Payment side (out of ATLAS's control)

- Set up Ko-fi (simplest) or Stripe (more control). Ko-fi has one-time and
  monthly tiers, no tax handling required for the maintainer up to ~$400/mo,
  and 0% platform fee if paid directly. Stripe is more work but scales.
- Decide tier structure. Suggestion:
  - **Supporter** ($3 one-time) → 💎 badge next to name in HUD (local only)
  - **Ace** ($10 one-time) → premium name effects (chrome, sparkle, wave)
  - **Legend** ($5/mo recurring) → animated name effects + custom color palettes
- Attribute payments to a Firebase UID. Ko-fi lets buyers add a custom note;
  instruct them to paste their in-game player ID there. Manual reconciliation
  is fine at 50 users.

### ATLAS-side integration

- New Firestore collection `donor_unlocks/{uid}` written by admin only.
  Rules:
  ```
  match donor_unlocks/{uid} {
      allow read: if request.auth != null || true;  // public for now
      allow write: if false;   // admin SDK only
  }
  ```
  Shape: `{ tier: "supporter" | "ace" | "legend", unlocks: [ids], expiresAt?: ts }`.
- Client fetches `donor_unlocks/{myUid}` on boot, caches locally.
- Forge panel gets a new "🎁 Supporter unlocks" section. Locked entries show
  a lock icon + "Donate to unlock" button that opens Ko-fi in a new tab.
  Unlocked entries can be selected like any other Forge effect.
- HUD title bar picks up a subtle 💎 badge for donors (local render).

### Redemption flow (maintainer script)

- Weekly (or on-demand): read Ko-fi payment log, match payer-noted UID to a
  Firebase user, add/renew `donor_unlocks/{uid}` doc. 15-line Node script,
  runs manually until it's worth automating.

### Design mockup

Forge panel gets a new section between existing effects and Save. Locked
tiles use a lock overlay; unlocked ones look like any other Forge effect.

```
┌─── Name Forge ────────────────────┐
│  ...existing name/color pickers... │
│                                    │
│  ─── Effects ───                   │
│  ✓ Solid   ✓ Gradient   ✓ Wave     │
│                                    │
│  ─── 🎁 Supporter unlocks ───      │
│  ✓ Chrome    (Ace tier)            │
│  🔒 Sparkle  Donate to unlock      │
│  🔒 Rainbow  Donate to unlock      │
│                                    │
│  Your tier: Ace · thank you 💎     │
│                                    │
│  [ Support ATLAS → ]               │
└────────────────────────────────────┘
```

### Legal / ops notes

- Ko-fi handles taxes for you below thresholds. Above them, you'll need to
  self-report.
- Refunds: honor them by revoking the unlock doc. Manual process is fine.
- Chargebacks: same. Rare at these amounts.
- Absolutely do NOT accept payment info directly. Always through Ko-fi/Stripe.
- Terms of service: one-page "unlocks are cosmetic, no gameplay advantage,
  fan-project not affiliated with the game" disclaimer.

---

## Tier 3 — Token earning system (post-Cloud-Functions migration)

DEFER until:
1. The schema migration in the Post-event section above ships.
2. `match_audits` collection has been collecting data for a few weeks (needs
   history to run the cross-check).
3. Cloud Functions are set up for authenticated writes (Phase E).

### If we ever upgrade Firebase plan or switch to Blaze

**Status: deferred while ATLAS stays on the no-payment-method Spark plan.**

Spark has enough Firestore quota for this community, but Firebase does not
allow Cloud Functions or scheduled functions without linking a billing
account and switching to Blaze. The secure coin design depends on those
trusted functions to mint rewards and process purchases.

While ATLAS remains on Spark:
- Do not add a client-writable coin balance.
- Do not store spendable coins or owned unlocks only in `localStorage`.
- Do not let the userscript submit its own reward amount, price, or resulting
  balance.
- Keep Rocket Buddy progression and Name Forge options cosmetic/local.
- A manual or external scheduled process could be explored separately, but it
  is not equivalent to the authenticated real-time purchase design below.

If the project ever moves to Blaze:
1. Add strict create-only rules for `match_audits`.
2. Deploy the corroborating reward aggregator in shadow mode first.
3. Keep balances and the reward ledger server-writable only.
4. Add an authenticated purchase function that looks up prices server-side.
5. Run shadow mode for at least two weeks before enabling purchases.
6. Configure budget alerts, `minInstances: 0`, low `maxInstances`, and usage
   monitoring before launch. Budget alerts are warnings, not a hard spend cap.

### Concept

Players earn tokens for verified activity:
- Playing matches (with `match_audits` corroboration)
- Winning matches (same corroboration)
- Participating in Clan Clash events (weighted higher during events)
- MMR grind (rank-tier-based; top players earn more per match)
- Long-term ATLAS use (small trickle to reward retention)

Tokens spend on:
- Cosmetic name effects (same catalog as donor unlocks, or a parallel one)
- Buddy customizations (skins, evolution shortcuts, retire-buddy-to-hall-of-fame)
- Clan Clash boosts (purely visual — leaderboard flair, banner colors during
  a specific event, "MVP" title on standings display)

### Why this is hard without CF

Client-computed token balances are trivially spoofable — one DevTools edit
and your balance is 999,999. The moment ONE person shows off a skin nobody
saw them earn, the system stops meaning anything.

### The correct architecture

Nightly Cloud Function job:
1. Read `match_audits` for the past 24h.
2. Group by match (same participants + timestamp window).
3. For each match, require N ≥ 2 corroborating audits from distinct
   players. Discard un-corroborated matches (probably fabricated).
4. Aggregate per-player token grants from validated matches only.
5. Write to `users/{uid}.tokens` (admin-only writable).
6. Client reads `users/{uid}.tokens`, spends via authenticated CF call
   that debits + grants unlock.

### Token math (rough starting point)

- Match played: 1 token (both teams, so no incentive to throw)
- Match won: +2 tokens
- Clan Clash event match (during event window): 2× multiplier on both
- MMR at time of match: +0.5 token per 100 MMR above 1000 (top players
  earn faster but ceiling is still soft)
- Daily first-match bonus: +5 tokens (retention nudge without idle grind)
- Weekly session-count bonus: +50 for 4+ active days that week

Rough steady-state: casual player earns ~50 tokens/day, top grinder
~200/day. Unlocks priced at 100-500 tokens for cosmetic effects, 1000+
for the rare stuff.

### Design mockup — Token panel

Would live in the same tab as Rocket Buddy, or its own new tab.

```
┌─── Tokens ────────────────────────┐
│                                    │
│         ⭐  1,247                  │
│       (+47 today · +312 this week) │
│                                    │
│  ─── Available unlocks ───         │
│  Chrome effect     · 250 ⭐        │
│  Sparkle effect    · 500 ⭐        │
│  Buddy retirement  · 800 ⭐        │
│  Clan MVP banner   · 1200 ⭐       │
│                                    │
│  ─── This week ───                 │
│  4 days active      +200 ⭐        │
│  1 Clash win        +100 ⭐        │
│  Top 50 in 3v3      +25/match      │
│                                    │
│  [ Spend ]  [ How to earn ]        │
└────────────────────────────────────┘
```

### Roll-out plan

1. Ship Rocket Buddy (Tier 1). No servers.
2. Ship donation unlocks (Tier 2). Manual admin reconciliation.
3. Migrate the schema per Post-event plan above.
4. Set up Cloud Functions.
5. Run the token aggregator job for 2 weeks in a "shadow mode" (writes
   to `users/{uid}.tokens_preview`, no spending enabled) so you can
   sanity-check the numbers before anyone can spend fake tokens.
6. Enable spending. Watch for abuse. Adjust.

### Alternative: peer-visible unlocks

Even if the CF audit fails or is deferred forever, one social trick makes
the system durable: every unlock announcement goes to a shared #atlas-unlocks
channel. Bob unlocks a rainbow name at 500 tokens → ping shows in Discord.
Community sees the unlock. If nobody remembers Bob grinding for it, he gets
called out. Free anti-cheat via peer pressure at 50-user scale.

---

## Skipped, do not do

- Full CF migration for every clan write. Not worth the eng cost for a
  50-user community until abuse actually happens. See Phase E.
- Version-gate / device-blacklist hardening. Spoofable by design. Not
  fixable without CF auth. The current behavior is friction, not a
  fortress, and the code comment at line 100 is honest about it.
- Rewriting the `_inMatch` state machine. It works. v13.5 was the right
  call. Just keep the watchdog we ship in 13.6.

## Reference: review findings this todo came from

The full review is in git history + the associated conversation. Key
line numbers as of 13.5:
- rg_hud.user.js:1629 - updateMyClanMMR, full members[] clobber
- rg_hud.user.js:2124 - maybeCaptureEventBaseline, eventBaseline map clobber
- rg_hud.user.js:2429 - onSnapshot clan listener
- rg_hud.user.js:2479 - loadClanData
- rg_hud.user.js:2899 - refreshDirectory, full-doc overwrite race
- rg_hud.user.js:1510-1529 - leaderboard query-then-patch-or-add
- rg_hud.user.js:1114-1134 - version gate (spoofable, don't try to fix)
- rg_hud.user.js:104-113 - device ID (spoofable, don't try to fix)
