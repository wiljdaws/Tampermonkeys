# Contributing to ATLAS

Thanks for wanting to help. ATLAS is a community Tampermonkey script for
[Rocket Goal](https://rocketgoal.io). Players install it from the raw
`rg_hud.user.js` on `main`.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Talk first on bigger changes

Open an issue or ping Pal / JesusDied4U in the
[Championship Discord](https://discord.gg/MDz7hsrh9m) before you:

- Change Firestore document shapes (`clans`, `leaderboard`, `admin/blacklist`)
- Add new Firestore reads or writes
- Touch auth, allow-list, or ban-list behavior
- Bump `minVersion`

Small HUD copy, bug fixes, and tests are fine as a pull request.

## Hard limits

This project stays on the Firebase **Spark** free plan (50k reads / 20k writes
a day). Do not add collection scans, visitor telemetry, or live listeners that
the public sites do not need.

Do not:

- Enable App Check
- Lower `MAX_MMR`
- Gate clan writes on the HUD allow list
- Bind clan `leaderId` to `request.auth.uid`
- Commit secrets, service-account JSON, or `.claude/settings.local.json`

## How to work

1. Fork the repo and branch from `main`.
2. Keep HUD changes in `rg_hud.user.js` unless you are working on the
   publisher or Firebase helpers.
3. Bump the userscript `@version` when you change the HUD.
4. Run the Firebase / publisher tests if you touched those paths:
   `node --test firebase/tests/*.test.mjs`
5. Open a pull request using the template.

Players update from
`https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js`.
A broken `main` is a broken install.

## Related repos

- Player board: [wiljdaws/rg_player_leaderboard](https://github.com/wiljdaws/rg_player_leaderboard)
- Clan Clash site: [wiljdaws/RG_Clan_Leaderboard](https://github.com/wiljdaws/RG_Clan_Leaderboard)

## Security

Do not file a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
