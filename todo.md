# ATLAS TODO

Everything I still want to do on ATLAS, in the rough order it can happen.
None of it is on fire.

## The list

1. [Split the code into smaller files](#1-split-the-code-into-smaller-files)
2. [Firestore cleanup after Clan Clash ends](#2-firestore-cleanup-after-clan-clash-ends)
3. [Keep MMR members earned when they leave](#3-keep-mmr-members-earned-when-they-leave)
4. [Donation unlocks](#4-donation-unlocks)
5. [Earn tokens by playing](#5-earn-tokens-by-playing)

---

## 1. Split the code into smaller files

`rg_hud.user.js` is 7,500 lines now. It works fine, but it's a pain to
find anything. The plan is to break it into a few smaller files and use a
tool called **vite-plugin-monkey** to glue them back into one userscript
when I build.

Two things worth remembering:

- **Users won't notice a thing.** They still install the same
  `rg_hud.user.js` from the same GitHub URL. The `@updateURL` keeps working
  because it points at the built file.
- **It's free.** vite-plugin-monkey, Vite, and Node are all free and open
  source. The only cost is disk space for `node_modules` on my machine.

### Setup, when I get around to it

Do this once, at the repo root:

1. Install Node 18 or newer if I don't have it.
2. Set up the package and install the plugin:
   ```bash
   npm init -y
   npm install --save-dev vite vite-plugin-monkey
   ```
3. Add a `vite.config.js`. The plugin's README
   (https://github.com/lisonge/vite-plugin-monkey) has the exact template.
   Just copy the `==UserScript==` header fields (name, match, version,
   updateURL, downloadURL, icon) into the `userscript` block, and point the
   `entry` at `src/main.js`. Set the output to `rg_hud.user.js` at the repo
   root so the existing `@updateURL` keeps working.
4. Add scripts to `package.json`:
   ```json
   "scripts": {
     "dev": "vite",
     "build": "vite build"
   }
   ```
5. Make a `src/` folder and start moving pieces over (see below). **Do
   this in slices**, not one giant rewrite. Build and reinstall after each
   slice so I catch anything I broke early.
6. Once the built file behaves like the old one, commit it. Users pull the
   built file via `@updateURL`; the split-up source lives in `src/`.
7. Later, maybe set up a GitHub Action that runs `npm ci && npm run build`
   on push so I don't have to remember.

### How to split the folder

```
src/
  main.js     the outer wrapper, wires everything up
  debug/      dbg, dbgWarn, pushError, probeInput
  buddy/      state, skins, voice lines, view, sprite loading
  clan/       firebase, actions, view, roles
  forge/      RGNF (already fairly self-contained)
  hud/        shell, dialog, settings, title glow, toast
```

### Order to do it in

1. **Debug stuff first.** Small, self-contained, nothing else touches it.
   Safest to move first.
2. **Buddy next.** Already the most self-contained chunk.
3. **Clan after that.** Bigger but cleanly scoped.
4. **Forge is easy.** It's already wrapped in an `RGNF` object.
5. **HUD shell last.** `main.js` pulls all the above together.

---

## 2. Firestore cleanup after Clan Clash ends

There are a few race conditions and data-overwriting bugs in the Firestore
setup. All the fixes are fine on paper, but running them mid-event could
mess up live standings. So they wait.

### When it's safe to start

- The current Clan Clash event has ended.
- Final Clash standings are saved somewhere. Screenshot or Firestore
  export of every `clans/{id}` doc while the data still has the old shape.
- Nobody is actively grinding for the current event.

### Stuff to line up before touching anything

- The companion site at `wiljdaws.github.io/RG_Clan_Leaderboard/` reads the
  same Firestore. Its `js/scoring.js` is a copy of ATLAS's clan scoring
  math. Update the site in the same release window or the standings will
  drift between HUD and site.
- Bumping `admin/blacklist.minVersion` is how I nudge old clients to
  update.
- The migration script needs Firebase admin creds. Pal has them.

### Phase A, bridge release (ATLAS 13.7)

Write to both the old shape AND the new shape at the same time. Read the
new shape first, fall back to the old one if it's not there.

**Clan writes to update** in `rg_hud.user.js`:

- 1629 (updateMyClanMMR)
- 2124 (baseline)
- 2985 (requestJoin)
- 3021 (approveRequest)
- 3056 (kickMember)
- 3149 (setMemberRole)
- 3244 (transferLeadership)
- 3442 (leaveClan)

**Clan reads to update:**

- 2429 (onSnapshot)
- 2479 (loadClanData)
- 2486 (own clan refresh)

Same dual-read change in the companion site's `js/scoring.js`.

Bump `minVersion` to 13.7 in `admin/blacklist`. Wait 3 to 5 days for
people to update.

### Phase B, actually change the data shape

Write this as a Node script using firebase-admin. Make it safe to run
more than once (skip anything already migrated).

1. **Change `clans/{id}.members` from a list to a map keyed by user id.**
   Right now every write replaces the whole list. Once it's a map, I can
   update just one member's field at a time. No more accidentally wiping
   someone else's data. (Fixes H3, M9.)
2. **Move `eventBaseline` into the member entry.** Was
   `clans/{id}.eventBaseline{uid: mmr}`, becomes
   `members.{uid}.eventBaseline`. Baseline lives on the member, disappears
   when they leave. No more cross-member overwriting. (Fixes H2.)
3. **Break up `clans_directory/index` into one doc per clan** at
   `clans_directory/{clanId}`. Right now every client rebuilds one shared
   doc, and if two do it at once they clobber each other. (Fixes C4.) The
   site's browse view already uses `getDocs` on the whole collection so it
   still works.
4. **Change leaderboard docs from `leaderboard/{autoId}` to
   `leaderboard/{sourceUserId}`.** Kills the query-then-patch-or-add
   awkwardness at `rg_hud.user.js:1510-1529`. For each unique
   `sourceUserId`, keep the newest doc, rekey it, delete the auto-ID one.
5. **`admin/blacklist.deviceHashes[]` becomes a subcollection**
   `admin_blacklist/{hash}`. Rules can do a fast doc-exists check per
   write instead of walking the whole list. Safe to do independently. The
   client never reads `deviceHashes` anyway.
6. **`clan_notices/{userId}` becomes `users/{uid}/notices/{noticeId}`.**
   Access control fix, not a data fix. Needs the same dual-read bridge.
   Only matters once I have real auth (see Phase E).

### Phase C, ATLAS 13.8, drop the bridge

Stop writing the old shape. Add a Firestore rule that rejects
`request.resource.data.members is list`. Also reject `versionNum < 13.7`
once basically everyone's on the new version.

### Phase D, tighten Firestore rules (can run alongside A to C)

Even without server-side auth, these help:

- `clans/{id}`: `leaderId` can only be changed by the current leader.
- `script_submissions/{playerId}` and `leaderboard/{playerId}`: doc key
  has to match the claimed `sourceUserId`. Cheap identity check.
- `admin/blacklist`: read-only for clients, admin-only writes.
- `versionNum is number && versionNum >= 13.7`.
- Cap `clans/{id}.joinRequests` at 50 entries so nobody can DoS a clan.

### Phase E, only if trolling actually becomes a problem

Server functions that verify who you are before letting you write to the
leaderboard or clan docs. Uses the Firebase ID token the game itself
already hands out. `v0304_player/nickname` already does this pattern.

Don't do it until abuse actually happens. It's the right way to do it,
but it's weeks of work for a 50-person group that mostly self-polices.

### Check when the migration's done

- [ ] No `members: [...]` array writes in Firestore for 24 hours.
- [ ] Every active clan has `members.{uid}.eventBaseline` filled in for
      the current event.
- [ ] `leaderboard` has zero duplicate `sourceUserId` values.
- [ ] `clans_directory` has one doc per clan; the old `/index` doc is
      gone or ignored.
- [ ] Companion site loads clan standings and they match the HUD.
- [ ] Clan Clash points line up between HUD and site to the exact number.
- [ ] `admin/blacklist.minVersion == 13.7` (or whatever I shipped).

### v13.6 followups (not blocking, do whenever)

**Firestore rules for `match_audits/{autoId}`.** New collection added in
13.6. It's write-only and append-only. The client shrugs it off if writes
fail. To actually collect the data:

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

One small doc per player per ranked match ends up being around 500 to 2000
docs a day at 50 users. Basically free.

---

## 3. Keep MMR members earned when they leave

Right now, when someone leaves a clan or gets kicked, all the MMR they
earned while in the clan just vanishes from `totalMMR`. Feels wrong — a
member can grind 500 MMR for the clan, catch a ban or a beef, and the
clan is worse off than before they joined. That shouldn't be how it works.

Fix: bank the gains. When someone leaves, whatever they earned while
they were in the clan sticks around in a retained bucket. They walk, the
number stays.

### Two new fields on the clan doc

- `retainedMMR` at the top level. Running total of banked gains from
  every past member. Starts at 0.
- `joinMMR` on each member entry. Stamped when they join, never touched
  again during their tenure.

### What happens on kick or leave

```js
const contrib = Math.max(0, member.mmr - (member.joinMMR ?? member.mmr));
clan.retainedMMR += contrib;
// then strip them from members like today
```

Positive-only. If they dropped MMR while in the clan, `retainedMMR` is
unchanged. Kicking a member who's slumping doesn't help or hurt the
number, so nobody gets kicked just to game it.

### Display

Wherever `totalMMR` shows up in the HUD or on the companion site, show
`totalMMR + retainedMMR` as one combined number. No new UI, no visual
noise. Just a bigger, more honest total.

### Rejoins

Fresh start every time. Bob leaves at 1500 (banks 500), rejoins a month
later at 1300 — we stamp him with `joinMMR = 1300` and go. The 500 he
banked from his first stint stays banked forever. If he grinds up to
1600 and leaves again, we bank another 300. Simple. Every stint is its
own thing.

### Backfill for members already in clans

On the next `updateMyClanMMR` sync, if a member has no `joinMMR`, stamp
it with their current MMR. They contribute zero retained if they leave
right away, but every future gain counts. Nobody loses anything they've
already earned; they just start being properly tracked from now on.

### Cost

Zero new reads or writes. Both fields piggyback on the existing per-match
clan sync. Just extra bytes in a doc we're already writing.

### Best done alongside Phase B of section 2

Section 2's Phase B already reshapes `members` from an array to a map.
Adding `joinMMR` at the same time means one migration pass over member
entries, not two. Have the migration script stamp
`joinMMR = mmr` on every existing member as it flips the shape. Clan doc
gets `retainedMMR: 0` at the same time.

### Check when it ships

- [ ] Kick and leave both bank positive contribs into `retainedMMR`.
- [ ] Members whose MMR dropped contribute zero on kick, never negative.
- [ ] Rejoin resets `joinMMR` cleanly, doesn't touch what's already banked.
- [ ] `totalMMR + retainedMMR` shows everywhere `totalMMR` used to.
- [ ] Legacy members get backfilled on next sync without breaking anything.
- [ ] Companion site's `js/scoring.js` adds `retainedMMR` to its sum too.

---

## 4. Donation unlocks

### Why bother

ATLAS runs on Firebase's free plan today. That's fine for what it does
right now, but everything I want to build next (more clan features, live
match data, richer stats, more reads and writes across the board) will
eventually push it past the free tier. Donations would go straight back
into the HUD: paying for the Firebase upgrade, covering storage as it
grows, and funding time to build the features people keep asking for.

Donors get a small cosmetic thank-you on their end. Nothing about gameplay
changes.

### The plan

Real money in, real unlock out. Nobody can fake it. Probably a weekend of
work total. Talk to Pal first.

### The payment side (not my problem to code)

- **Ko-fi** is simplest. **Stripe** if I want more control. Ko-fi does
  one-time and monthly, doesn't make me deal with taxes below about
  $400/mo, and takes 0% if paid directly. Stripe is more setup but scales.
- Tier idea:
  - **Supporter** at $3 one-time gets a 💎 badge next to name in HUD (local only)
  - **Ace** at $10 one-time gets premium name effects (chrome, sparkle, wave)
  - **Legend** at $5/mo gets animated name effects and custom palettes
- Attribute payments to a Firebase user ID. Ko-fi lets buyers add a note.
  Tell them to paste their in-game player ID there. At 50 users I can
  match them up by hand.

### The ATLAS side

- New Firestore collection `donor_unlocks/{uid}`, admin writes only:
  ```
  match donor_unlocks/{uid} {
      allow read: if true;
      allow write: if false;   // admin SDK only
  }
  ```
  Shape: `{ tier: "supporter" | "ace" | "legend", unlocks: [ids], expiresAt?: ts }`.
- Client grabs `donor_unlocks/{myUid}` on boot, caches it locally.
- Forge panel gets a "🎁 Supporter unlocks" section. Locked entries show a
  lock icon and a "Donate to unlock" button that opens Ko-fi in a new tab.
- HUD title bar picks up a subtle 💎 badge for donors (local only).

### Redeeming payments

Once a week or when someone pings me, read the Ko-fi payment log, find
the noted user ID, add or renew `donor_unlocks/{uid}`. Maybe 15 lines of
Node. Run by hand until it's worth automating.

### Rough forge mockup

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

### Legal and operational stuff

- Ko-fi handles taxes below their thresholds. Above that I self-report.
- Refunds: give the money back, remove the unlock doc.
- Chargebacks: same. Rare at these amounts.
- **Never accept payment info directly.** Always through Ko-fi or Stripe.
- Write a one-page terms page: "unlocks are cosmetic, no gameplay
  advantage, this is a fan project, not affiliated with the game."

---

## 5. Earn tokens by playing

**Not until:**

1. The Firestore cleanup in section 2 has shipped.
2. `match_audits` has been collecting data for a few weeks. Need history
   before the cross-check makes sense.
3. Server functions are set up (Phase E in section 2).

### Firebase plan problem

ATLAS is on Firebase's free Spark plan (no billing account attached).
Spark has plenty of Firestore quota, but Firebase won't run server
functions without a billing account (Blaze). This whole token idea needs
server functions to hand out and spend tokens safely.

**While I'm on Spark, DO NOT:**

- Add a token balance the client can write to.
- Store spendable tokens or owned unlocks only in localStorage.
- Let the userscript tell the server how many tokens to give it or what a
  price is.
- Make Buddy or Forge unlocks anything but cosmetic and local.

**If I ever move to Blaze:**

1. Add strict create-only rules for `match_audits`.
2. Deploy the reward aggregator in test mode first (writes to a fake
   field, no real balance change).
3. Balances and the reward log are server-writable only.
4. Purchases go through a server function that looks up the price on the
   server, not the client.
5. Run test mode for at least two weeks before letting anyone actually
   spend tokens.
6. Set budget alerts, keep `minInstances: 0`, low `maxInstances`, and
   watch usage. **Budget alerts are warnings, not a hard cap.**

### The idea

Players earn tokens for verified activity:

- Playing matches (backed up by `match_audits` from other players)
- Winning matches (same backup)
- Playing during Clan Clash events (worth more)
- MMR grind (higher-rank players earn more per match)
- Sticking around long-term (small trickle for coming back)

Tokens spend on:

- Cosmetic name effects (same catalog as donor unlocks, or a parallel one)
- Buddy stuff (skins, evolution shortcuts, retire your buddy to a hall of
  fame)
- Clan Clash flair (visual only, so leaderboard highlights, banner colors,
  "MVP" tag on standings)

### Why this is hard without server functions

Anything the client calculates can be faked in 10 seconds with DevTools.
The instant one person shows off a skin nobody remembers them earning,
the whole system feels pointless.

### How it needs to actually work

Nightly server job:

1. Read `match_audits` for the last 24 hours.
2. Group by match (same players and timestamp window).
3. Only count matches where at least 2 other players' audits back it up.
   Throw the rest out. Probably fake.
4. Add up token grants per player from the verified matches.
5. Write to `users/{uid}.tokens` (server-only writes).
6. Client reads `users/{uid}.tokens` and spends via a server function that
   subtracts the balance and hands over the unlock in one step.

### Rough token math to start with

- Match played: 1 token (both teams get it, so no reason to throw matches)
- Match won: +2
- Match during a Clan Clash event: 2x everything
- MMR at time of match: +0.5 per 100 MMR above 1000
- First match of the day: +5
- 4+ active days that week: +50

Typical: casual player earns around 50/day, hardcore grinder around
200/day. Unlocks priced at 100 to 500 for common cosmetics, 1000+ for the
rare stuff.

### Token panel mockup

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

### Order to ship

1. Ship Rocket Buddy (Tier 1). No servers needed.
2. Ship donation unlocks (Tier 2). Reconcile payments by hand.
3. Migrate the Firestore shape (section 2).
4. Set up server functions.
5. Run the reward aggregator in test mode for 2 weeks. Writes go to
   `users/{uid}.tokens_preview`, spending disabled, so I can sanity-check
   the numbers before anyone can spend fake tokens.
6. Turn spending on. Watch for people trying to cheat. Adjust.

### Cheap backup plan if the audit thing never happens

Even without any real verification, one social trick makes this work at
50 users: every unlock gets announced in a shared Discord channel. Bob
unlocks a rainbow name at 500 tokens, ping shows up in `#atlas-unlocks`.
Everyone sees it. If nobody remembers Bob grinding for it, he gets called
out. Peer pressure is free.

