// ==UserScript==
// @name         ATLAS Dev
// @namespace    https://rocketgoal.io/dev
// @version      14.3-dev
// @description  Dev build of ATLAS. Testing the sprite buddy button, opt-out toggle, and leaderboard-opponent popup. Install alongside the prod ATLAS to compare.
// @author       JesusDied4U
// @icon         https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/atlas/atlas.png
// @match        https://rocketgoal.io/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/dev/rg_hud_dev.user.js
// @downloadURL  https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/dev/rg_hud_dev.user.js
// @supportURL   https://github.com/wiljdaws/Tampermonkeys/issues
// ==/UserScript==

(function () {
    'use strict';

    // Debug logging lives up here so anything below can call dbg() safely,
    // including the early localStorage try/catches.
    const oldLog = console.log;
    const RG_DEBUG = true;
    const _rgLogBuf = [];
    const _rgWarnBuf = [];
    const _rgErrorBuf = [];
    function dbg(msg) {
        const line = `[RG HUD ${(performance.now() / 1000).toFixed(2)}s] ${msg}`;
        _rgLogBuf.push(line);
        if (_rgLogBuf.length > 300) _rgLogBuf.shift();
        if (RG_DEBUG) oldLog.call(console, line);
    }
    function dbgWarn(msg) {
        dbg("[WARN] " + msg);
        _rgWarnBuf.push({ msg, at: Date.now() });
        if (_rgWarnBuf.length > 5) _rgWarnBuf.shift();
        const dot = typeof document !== "undefined" && document.getElementById("rgWarnDot");
        if (dot) {
            dot.style.display = "inline";
            dot.title = _rgWarnBuf.map(w => new Date(w.at).toLocaleTimeString() + " — " + w.msg).join("\n");
        }
    }
    function pushError(err, origin) {
        try {
            const message = (err && err.message) ? err.message : String(err);
            const stack = (err && err.stack) ? String(err.stack).split("\n").slice(0, 6).join(" | ") : "";
            _rgErrorBuf.push({ origin, msg: message, stack, at: Date.now() });
            if (_rgErrorBuf.length > 20) _rgErrorBuf.shift();
            dbg(`[ERROR:${origin}] ${message}${stack ? " :: " + stack : ""}`);
        } catch (loggingFailed) {
            try { oldLog.call(console, "[RG HUD] pushError failed:", loggingFailed); } catch (e) {}
        }
    }
    // Wire a text input so a "can't type" bug leaves a trail in the log:
    // did focus land, did a keystroke ever arrive, did focus get yanked away.
    function probeInput(el, label) {
        if (!el) { dbg(`probeInput(${label}): element missing`); return; }
        setTimeout(() => {
            try {
                const active = document.activeElement;
                const cs = window.getComputedStyle(el);
                dbg(`${label} probe: activeId=${active?.id || "none"} focused=${active === el} disabled=${el.disabled} readOnly=${el.readOnly} display=${cs.display} visibility=${cs.visibility} pointerEvents=${cs.pointerEvents}`);
            } catch (e) { pushError(e, `probeInput:${label}`); }
        }, 120);
        const onFirstInput = () => {
            dbg(`${label} first keystroke received (len=${el.value.length})`);
            el.removeEventListener("input", onFirstInput);
        };
        const onFirstBlur = () => {
            const active = document.activeElement;
            dbg(`${label} focus lost -> ${active?.id || active?.tagName || "unknown"}`);
            el.removeEventListener("focusout", onFirstBlur);
        };
        el.addEventListener("input", onFirstInput);
        el.addEventListener("focusout", onFirstBlur);
    }

    // Expose on the page window so DevTools "top" context can hit rgDump().
    (typeof unsafeWindow !== "undefined" ? unsafeWindow : window).rgDump =
        () => oldLog.call(console, _rgLogBuf.join("\n"));
    // Catch anything a handler throws so it shows up in the debug bundle
    // instead of vanishing silently.
    if (typeof window !== "undefined") {
        window.addEventListener("error", ev => {
            pushError(ev.error || ev.message || "unknown error", "window.error");
        });
        window.addEventListener("unhandledrejection", ev => {
            pushError(ev.reason || "unhandled rejection", "unhandledrejection");
        });
    }

    let hud;

    // img not emoji, stays crisp cross-OS
    const ATLAS_ICON_URL = 'https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/atlas/atlas.png';
    const BUDDY_ATLAS_BASE = 'https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/atlas/';
    // Classic stays commit-pinned so older installs keep a known-good sheet.
    // Newer skins track main so art updates ship with the repo.
    const BUDDY_SKINS = {
        classic: {
            id: "classic",
            label: "Rocket Car",
            sheetUrl: "https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/e29161741cedca30b6a72be401a4dc51b50470a9/atlas/rocket_buddy_sheet.png",
            stages: [
                { name: "Ignition", icon: "🛞" },
                { name: "Rookie Booster", icon: "🏎️" },
                { name: "Ace Racer", icon: "🚗" },
                { name: "Champion Ride", icon: "🏁" },
                { name: "Legendary Fleet", icon: "🚀" },
            ],
        },
        goblin: {
            id: "goblin",
            label: "Garage Goblin",
            sheetUrl: BUDDY_ATLAS_BASE + "rocket_buddy_garage_goblin_sheet.png",
            stages: [
                { name: "Oily Apprentice", icon: "🔧" },
                { name: "Pit Crew Rookie", icon: "⛑️" },
                { name: "Crew Chief", icon: "📋" },
                { name: "Championship Engineer", icon: "🏆" },
                { name: "Legendary Tuner", icon: "✨" },
            ],
        },
        scrap: {
            id: "scrap",
            label: "Scrapyard Scrapling",
            sheetUrl: BUDDY_ATLAS_BASE + "rocket_buddy_scrapyard_sheet.png",
            stages: [
                { name: "Tin Can Skater", icon: "🥫" },
                { name: "Cart Chassis", icon: "🛒" },
                { name: "Derby Crate", icon: "📦" },
                { name: "Scrap Tank", icon: "🛡️" },
                { name: "Junkyard King", icon: "👑" },
            ],
        },
        critter: {
            id: "critter",
            label: "Arena Critters",
            sheetUrl: BUDDY_ATLAS_BASE + "rocket_buddy_arena_critters_sheet.png",
            stages: [
                { name: "Bumper Hamster", icon: "🐹" },
                { name: "Turbo Raccoon", icon: "🦝" },
                { name: "Octane Fox", icon: "🦊" },
                { name: "Rocket Panther", icon: "🐆" },
                { name: "Stadium Griffin", icon: "🦅" },
            ],
        },
        peasant: {
            id: "peasant",
            label: "Peasant → King",
            sheetUrl: BUDDY_ATLAS_BASE + "rocket_buddy_peasant_king_sheet.png",
            stages: [
                { name: "Mudfoot Peasant", icon: "🌾" },
                { name: "Village Squire", icon: "🗡️" },
                { name: "Knight Errant", icon: "🛡️" },
                { name: "Royal Champion", icon: "🏅" },
                { name: "Legendary King", icon: "👑" },
            ],
        },
        feline: {
            id: "feline",
            label: "Cat → Lion",
            sheetUrl: BUDDY_ATLAS_BASE + "rocket_buddy_cat_lion_sheet.png",
            stages: [
                { name: "Kitten Spark", icon: "🐱" },
                { name: "Alley Racer", icon: "😺" },
                { name: "Track Lynx", icon: "🐈" },
                { name: "Arena Panther", icon: "🐆" },
                { name: "Legendary Lion", icon: "🦁" },
            ],
        },
    };
    const BUDDY_SKIN_ORDER = ["classic", "goblin", "scrap", "critter", "peasant", "feline"];

    // Per-skin status voice. Classic keeps the original car garage lines below;
    // other skins swap in themed copy for the same event keys.
    const BUDDY_SKIN_VOICE = {
        goblin: {
            skinSelect: ({ name, label }) => [
                `${name} clocked in as ${label}. Oil under the nails already.`,
                `${name} grabbed a wrench bigger than their ego. Garage Goblin mode.`,
                `${name} joined the pit crew. Someone hide the good sockets.`,
            ],
            sleepy: ({ name }) => [
                `${name} is napping on a stack of tire catalogs. Do not start the impact gun.`,
                `${name} entered sleep mode next to the oil drum. Snoring sounds like a loose belt.`,
                `${name} is dreaming of perfectly torqued lug nuts and unlimited shop towels.`,
            ],
            neglected: ({ name }) => [
                `${name} has started alphabetizing the rusted bolts. A pet might help.`,
                `${name} wrote "WHERE HUMAN" in grease on the bay floor.`,
                `${name} checked the toolbox again. Still no snacks. Only sockets.`,
            ],
            pet: ({ name }) => [
                `${name} got a head pat and immediately tried to tune something that did not need tuning.`,
                `${name} received affection. Horsepower of the heart: +12. Actual horsepower: classified.`,
                `${name} was petted and left a tiny oily handprint of gratitude.`,
                `${name} says "again." The cooldown and the shop manager both say no.`,
            ],
            evolve: ({ name, stageName }) => [
                `${name} got promoted to ${stageName}. The pit wall just stood a little taller.`,
                `${name} unlocked ${stageName}! Please admire the new grease stains responsibly.`,
                `${name} evolved into ${stageName}. Somewhere, a tiny ratchet cried happy tears.`,
            ],
            matchBigWin: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} deep. The other cars asked for a different mechanic.`,
                `${name} has entered championship-engineer rage. Telemetry is applauding.`,
                `${name} is wrenching wins out of thin air. OSHA is concerned, impressed, then concerned.`,
                `${name} tuned the lobby until it broke. In a good way.`,
                `${name} is so hot the coolant is filing a complaint.`,
            ],
            matchHotWin: ({ name, streak }) => [
                `${name} is ON FIRE in the bay. Keep flammable rags at a safe distance.`,
                `${name} is ${Math.abs(streak)} wins deep and still asking for a smaller socket.`,
                `${name} is cooking. Recipe: boost, spite, and a suspiciously clean air filter.`,
                `${name} has entered main-character pit-crew mode.`,
                `${name} smells victory. Also 5W-30.`,
            ],
            matchMultiWin: ({ name, wins }) => [
                `${name} banked ${wins} wins and would like them hung above the tool chest.`,
                `${name} chained ${wins} wins. Chain looks like a drive belt under tension.`,
                `${name} racked up ${wins}. Loading additional swagger... and more rags.`,
                `${name} secured ${wins} in a row. The clipboard is impressed.`,
            ],
            matchWin: ({ name }) => [
                `${name} found the boost button and a torque wrench. Dangerous combo.`,
                `${name} snagged a W. Momentum: initialized. Oil: everywhere.`,
                `${name} says that was calculated. The dyno printout disagrees.`,
                `${name} added one win and approximately twelve horsepower of attitude.`,
            ],
            matchBigLoss: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} losses deep. Suggestion: mercy rule and a shop towel.`,
                `${name} requested a tactical blanket and no follow-up questions about alignment.`,
                `${name} insists this is an extremely long training montage in the garage.`,
                `${name} is building character. And a very sad parts list.`,
            ],
            matchColdLoss: ({ name, streak }) => [
                `${name} is Frosty. Warm-up laps, snacks, and maybe a heated bay prescribed.`,
                `${name} filed a formal complaint against matchmaking. In triplicate. Greasy.`,
                `${name} needs encouragement, premium fuel, and a tiny scarf over the goggles.`,
                `${name} is ${Math.abs(streak)} cold. Consider hot cocoa. Do not drink the coolant.`,
            ],
            matchMultiLoss: ({ name, losses }) => [
                `${name} survived ${losses} learning opportunities at shop-floor speed.`,
                `${name} calls those ${losses} losses "extensive field research."`,
                `${name} logged ${losses} Ls into the shame ledger next to the invoices.`,
                `${name} took ${losses} on the chin. Chin still has grease on it.`,
            ],
            matchLoss: ({ name }) => [
                `${name} hit a learning opportunity at supersonic speed. Air filter unimpressed.`,
                `${name} says the controller was slippery. Also everything else was oily.`,
                `${name} lost. Blames physics. And that one mystery rattle.`,
                `${name} took an L. Happens to the best of sockets.`,
            ],
            matchMixed: ({ name, wins, losses }) => [
                `${name} processed ${wins}W/${losses}L and now requires a tiny spreadsheet of torque specs.`,
                `${name} had a complicated session. Telemetry just sighed in the bay.`,
                `${name} went ${wins}-${losses}. Vibes: mixed oil grades.`,
                `${name} banked wins AND losses. Equal-opportunity garage.`,
            ],
        },
        scrap: {
            skinSelect: ({ name, label }) => [
                `${name} rolled out of the pile as ${label}. Rust is a lifestyle.`,
                `${name} chose the scrapyard life. Magnet crane approved.`,
                `${name} is now certified junkyard royalty. Tin crown pending.`,
            ],
            sleepy: ({ name }) => [
                `${name} is sleeping inside a discarded fridge. Do not close the door.`,
                `${name} parked for a power nap on a stack of license plates.`,
                `${name} is dreaming of unlimited scrap and suspiciously shiny hubcaps.`,
            ],
            neglected: ({ name }) => [
                `${name} has started collecting dust as a rare metal. A pet might help.`,
                `${name} is composing a ballad titled "Where Did My Human Go (feat. Magnet)."`,
                `${name} checked the scrap pile again. Still no snacks. Only bolts.`,
            ],
            pet: ({ name }) => [
                `${name} was just petted. Structural integrity increased by emotionally significant amounts.`,
                `${name} received head pats and is now legally unstoppable. Also slightly more rustproof.`,
                `${name} has been petted and is pretending the tin exterior doesn't love it.`,
                `${name} says "again." The cooldown says "absolutely not, scrapling."`,
            ],
            evolve: ({ name, stageName }) => [
                `${name} welded up into ${stageName}. Insurance refused the call.`,
                `${name} unlocked ${stageName}! Please admire the new dents responsibly.`,
                `${name} evolved into ${stageName}. Somewhere, a dumpster is crying happy tears.`,
            ],
            matchBigWin: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} deep. The junkyard filed a restraining order on the lobby.`,
                `${name} has weaponized scrap. Matchmaking is scared of magnets now.`,
                `${name} is dominating so hard the leaderboard just typed "gg" in rust.`,
                `${name} ascended to Junkyard King energy. Bow before the tin.`,
            ],
            matchHotWin: ({ name, streak }) => [
                `${name} is ON FIRE! Keep flammable scrap at a safe distance.`,
                `${name} is ${Math.abs(streak)} wins deep and unbearable already.`,
                `${name} smells victory. Also acetylene.`,
                `${name} is stacking Ws like crushed cars.`,
            ],
            matchMultiWin: ({ name, wins }) => [
                `${name} bagged ${wins} wins. The bag is a shopping cart and it's bulging.`,
                `${name} bulk-bought ${wins} wins. Costco of the scrapyard.`,
                `${name} chained ${wins} wins together with actual chain. Artistic.`,
                `${name} racked up ${wins}. Loading additional scrap swagger...`,
            ],
            matchWin: ({ name }) => [
                `${name} snagged a W. Filed under "valuable scrap."`,
                `${name} found the boost button in a glovebox they didn't own.`,
                `${name} won. The magnet crane salutes.`,
                `${name} added one win and approximately twelve rattles.`,
            ],
            matchBigLoss: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} losses deep. Suggestion: mercy rule and a tarp.`,
                `${name} has entered rock bottom's scrap basement.`,
                `${name} is speed-running character development in the junkyard.`,
                `${name} volunteered as the control group. Again.`,
            ],
            matchColdLoss: ({ name }) => [
                `${name} is Frosty. Warm-up laps and a heated seat from a donor car prescribed.`,
                `${name} filed a formal complaint against matchmaking. Written on a license plate.`,
                `${name} needs encouragement, premium fuel, and perhaps a tiny tarp-scarf.`,
                `${name} is chilly. Emotionally. Structurally still holding.`,
            ],
            matchMultiLoss: ({ name, losses }) => [
                `${name} survived ${losses} learning opportunities at dumpster speed.`,
                `${name} lost ${losses}, but the wheels are still emotionally attached. Barely.`,
                `${name} calls those ${losses} losses "extensive field research."`,
                `${name} logged ${losses} Ls into the shame ledger. Ledger is a napkin.`,
            ],
            matchLoss: ({ name }) => [
                `${name} hit a learning opportunity at supersonic scrap speed.`,
                `${name} lost. Blames physics. And that one mystery rattle. All of them, actually.`,
                `${name} took an L. Happens to the best of tin cans.`,
                `${name} dropped a match. Match landed softly on a stack of hubcaps.`,
            ],
            matchMixed: ({ name, wins, losses }) => [
                `${name} processed ${wins}W/${losses}L and now requires a tiny spreadsheet of scrap grades.`,
                `${name} went ${wins}-${losses}. Vibes: mixed metals.`,
                `${name} had a bipartisan session in the junkyard.`,
                `${name} banked wins AND losses. Equal-opportunity scrap pile.`,
            ],
        },
        critter: {
            skinSelect: ({ name, label }) => [
                `${name} scampered into ${label} form. Stadium security unprepared.`,
                `${name} chose Arena Critters. Tiny paws, catastrophic speed.`,
                `${name} is now a mascot with teeth. Cheer carefully.`,
            ],
            sleepy: ({ name }) => [
                `${name} is curled up in a goal hoop for a power nap.`,
                `${name} entered sleep mode. Snoring is now available in surround squeak.`,
                `${name} is dreaming of unlimited boost and suspiciously large sunflower seeds.`,
            ],
            neglected: ({ name }) => [
                `${name} has started collecting dust bunnies as pets. A real pet might help.`,
                `${name} is composing a dramatic ballad titled "Where Did My Human Go (feat. Hamster)."`,
                `${name} checked the tunnel again. Still no snacks. Only echo.`,
            ],
            pet: ({ name }) => [
                `${name} was just petted. Fluff-to-power ratio increased dramatically.`,
                `${name} received head pats and is now legally unstoppable. Whiskers approved.`,
                `${name} has been petted and is pretending not to purr-adjacent.`,
                `${name} says "again." The cooldown says "absolutely not, critter."`,
            ],
            evolve: ({ name, stageName }) => [
                `${name} evolved into ${stageName}. The stadium just got cuter and meaner.`,
                `${name} unlocked ${stageName}! Please admire the new claws responsibly.`,
                `${name} became ${stageName}. Somewhere, a tiny cheer squad lost its mind.`,
            ],
            matchBigWin: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} deep. The other cars filed a restraining order against the mascot.`,
                `${name} has achieved dangerous levels of zoom. And squeak.`,
                `${name} is dominating so hard the leaderboard just typed "gg" in pawprints.`,
                `${name} has ascended. Matchmaking cannot follow the scent trail.`,
            ],
            matchHotWin: ({ name, streak }) => [
                `${name} is ON FIRE! Keep flammable snacks at a safe distance.`,
                `${name} is ${Math.abs(streak)} wins deep and unbearable already.`,
                `${name} is cooking. Recipe: boost, spite, and sunflower seeds.`,
                `${name} has that gleam in the whiskers. Bad news for everyone.`,
            ],
            matchMultiWin: ({ name, wins }) => [
                `${name} bagged ${wins} wins. The bag is a cheek pouch and it's full.`,
                `${name} chained ${wins} wins. Chain looks like a happy little stampede.`,
                `${name} racked up ${wins}. Loading additional critter swagger...`,
                `${name} secured ${wins} in a row. Ownership papers pending. Soft ones.`,
            ],
            matchWin: ({ name }) => [
                `${name} snagged a W. Momentum: initialized. Tail: up.`,
                `${name} found the boost button. This is getting dangerous. And adorable.`,
                `${name} won. The universe permits this. The stadium cheers.`,
                `${name} added one win and approximately twelve zoomies.`,
            ],
            matchBigLoss: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} losses deep. Suggestion: mercy rule and a tiny blanket.`,
                `${name} requested a tactical burrow and no follow-up questions.`,
                `${name} insists this is an extremely long training montage in the tunnels.`,
                `${name} is building character. So much character. Very small body.`,
            ],
            matchColdLoss: ({ name }) => [
                `${name} is Frosty. Warm-up laps and snacks prescribed. Prefer seeds.`,
                `${name} filed a formal complaint against matchmaking. In squeaks.`,
                `${name} needs encouragement, premium fuel, and perhaps a tiny scarf.`,
                `${name} is chilly. Emotionally. Fur helps. Barely.`,
            ],
            matchMultiLoss: ({ name, losses }) => [
                `${name} survived ${losses} learning opportunities at critter speed.`,
                `${name} lost ${losses}, but the whiskers are still emotionally attached.`,
                `${name} calls those ${losses} losses "extensive field research."`,
                `${name} logged ${losses} Ls into the shame ledger. Ledger is a leaf.`,
            ],
            matchLoss: ({ name }) => [
                `${name} hit a learning opportunity at supersonic squeak.`,
                `${name} lost. Blames physics. And that one scary loud noise.`,
                `${name} took an L. Happens to the best of paws.`,
                `${name} dropped a match. Match landed softly in the burrow.`,
            ],
            matchMixed: ({ name, wins, losses }) => [
                `${name} processed ${wins}W/${losses}L and now requires a tiny spreadsheet of snacks.`,
                `${name} went ${wins}-${losses}. Vibes: mixed nuts.`,
                `${name} had a bipartisan session. Party animals only.`,
                `${name} banked wins AND losses. Equal-opportunity stadium.`,
            ],
        },
        peasant: {
            skinSelect: ({ name, label }) => [
                `${name} took up the ${label} path. Pitchfork optional. Attitude required.`,
                `${name} chose Peasant → King. The mud remembers this decision.`,
                `${name} is now on a royal arc. Try not to lose the crown in a ditch.`,
            ],
            sleepy: ({ name }) => [
                `${name} is napping against a hay bale. Do not start the joust.`,
                `${name} entered sleep mode. Snoring is now available in surround kingdom.`,
                `${name} is dreaming of unlimited boost and suspiciously large feasts.`,
            ],
            neglected: ({ name }) => [
                `${name} has started collecting dust as a noble hobby. A pet might help.`,
                `${name} is composing a dramatic ballad titled "Where Did My Liege Go?"`,
                `${name} checked the castle gate again. Still no snacks. Only mud.`,
            ],
            pet: ({ name }) => [
                `${name} was just petted. Morale increased by emotionally significant amounts.`,
                `${name} received head pats and is now legally unstoppable. Crown slightly crooked.`,
                `${name} has been petted and is pretending knights don't love that.`,
                `${name} says "again." The cooldown says "absolutely not, your muddiness."`,
            ],
            evolve: ({ name, stageName }) => [
                `${name} ascended to ${stageName}. The village insurance premium just moved.`,
                `${name} unlocked ${stageName}! Please admire the new armor responsibly.`,
                `${name} evolved into ${stageName}. Somewhere, a tiny squire is crying happy tears.`,
            ],
            matchBigWin: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} deep. The other knights filed a restraining order.`,
                `${name} has forgotten how losing works. Please do not remind the throne.`,
                `${name} is on the podium so often it has a favorite step. And a crown polish.`,
                `${name} has ascended to a plane matchmaking cannot follow. Royal decree.`,
            ],
            matchHotWin: ({ name, streak }) => [
                `${name} is ON FIRE! Keep flammable banners at a safe distance.`,
                `${name} is ${Math.abs(streak)} wins deep and unbearable already. Court agrees.`,
                `${name} has entered main-character mode. Narrator sweating.`,
                `${name} smells victory. Also mud. Mostly victory.`,
            ],
            matchMultiWin: ({ name, wins }) => [
                `${name} banked ${wins} wins. Turbo confidence engaged. Feudal style.`,
                `${name} claimed ${wins} in a row. Ownership papers pending. Very fancy.`,
                `${name} stacked ${wins} wins. Stack structurally alarming. Also regal.`,
                `${name} secured ${wins}. The clipboard (and the court) are impressed.`,
            ],
            matchWin: ({ name }) => [
                `${name} snagged a W. Momentum: initialized. Pitchfork: raised.`,
                `${name} won. The universe permits this. The village cheers.`,
                `${name} says that was calculated. It was not. Still counts.`,
                `${name} added one win and approximately twelve horsepower of destiny.`,
            ],
            matchBigLoss: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} losses deep. Suggestion: mercy rule and a warm hearth.`,
                `${name} requested a tactical blanket and no follow-up questions about the joust.`,
                `${name} insists this is an extremely long training montage in the mud.`,
                `${name} is building character. So much character. Very royal suffering.`,
            ],
            matchColdLoss: ({ name }) => [
                `${name} is Frosty. Warm-up laps, snacks, and a tiny scarf prescribed.`,
                `${name} filed a formal complaint against matchmaking. Sealed with a sad crest.`,
                `${name} needs encouragement, premium fuel, and perhaps a tiny cape.`,
                `${name} is chilly. Emotionally. Crown frost forming.`,
            ],
            matchMultiLoss: ({ name, losses }) => [
                `${name} survived ${losses} learning opportunities at quest speed.`,
                `${name} lost ${losses}, but the honor is still emotionally attached.`,
                `${name} calls those ${losses} losses "extensive field research."`,
                `${name} logged ${losses} Ls into the shame ledger. Ledger is a scroll.`,
            ],
            matchLoss: ({ name }) => [
                `${name} hit a learning opportunity at supersonic chivalry.`,
                `${name} lost. Blames physics. And that one muddy pothole.`,
                `${name} took an L. Happens to the best of knights.`,
                `${name} dropped a match. Match landed softly on the village green.`,
            ],
            matchMixed: ({ name, wins, losses }) => [
                `${name} processed ${wins}W/${losses}L and now requires a tiny spreadsheet of quests.`,
                `${name} went ${wins}-${losses}. Vibes: mixed feudalism.`,
                `${name} had a bipartisan session. Court divided.`,
                `${name} banked wins AND losses. Equal-opportunity kingdom.`,
            ],
        },
        feline: {
            skinSelect: ({ name, label }) => [
                `${name} stretched into ${label}. The pride accepts this appointment.`,
                `${name} chose Cat → Lion. Expect napping and sudden violence.`,
                `${name} is now feline-coded. Pet at your own risk. Also please pet.`,
            ],
            sleepy: ({ name }) => [
                `${name} is loafing in a sunbeam. Do not disturb the loaf.`,
                `${name} entered sleep mode. Snoring is now available in surround purr.`,
                `${name} is dreaming of unlimited boost and suspiciously large cardboard boxes.`,
            ],
            neglected: ({ name }) => [
                `${name} has started collecting dust as a hobby. A pet might help. Immediately.`,
                `${name} is composing a dramatic ballad titled "Where Did My Human Go (3am remix)."`,
                `${name} knocked something off the counter for attention. Still no snacks.`,
            ],
            pet: ({ name }) => [
                `${name} was just petted. Purr-to-power ratio increased dramatically.`,
                `${name} received head pats and is now legally unstoppable. Chin scratches pending.`,
                `${name} has been petted and is pretending not to love it. Tail says otherwise.`,
                `${name} says "again." The cooldown says "absolutely not, legend."`,
            ],
            evolve: ({ name, stageName }) => [
                `${name} evolved into ${stageName}. The pride just got louder.`,
                `${name} unlocked ${stageName}! Please admire the new mane responsibly.`,
                `${name} became ${stageName}. Somewhere, a tiny laser pointer is crying happy tears.`,
            ],
            matchBigWin: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} deep. The other cars filed a restraining order against the cat.`,
                `${name} has forgotten how losing works. Cats invented that attitude.`,
                `${name} is dominating so hard the leaderboard just typed "gg" in pawprints.`,
                `${name} has ascended. Matchmaking cannot follow. Neither can gravity, apparently.`,
            ],
            matchHotWin: ({ name, streak }) => [
                `${name} is ON FIRE! Keep flammable yarn at a safe distance.`,
                `${name} is ${Math.abs(streak)} wins deep and unbearable already.`,
                `${name} has entered main-character mode. Side characters fleeing.`,
                `${name} smells victory. Also tuna. Mostly victory.`,
            ],
            matchMultiWin: ({ name, wins }) => [
                `${name} bagged ${wins} wins. The bag is a paper bag. They sit in it now.`,
                `${name} chained ${wins} wins. Chain looks like a happy little pounce streak.`,
                `${name} racked up ${wins}. Loading additional feline swagger...`,
                `${name} secured ${wins} in a row. Ownership papers pending. Of everything.`,
            ],
            matchWin: ({ name }) => [
                `${name} snagged a W. Momentum: initialized. Tail: question mark → exclamation.`,
                `${name} found the boost button. Knocked it off the table first, then used it.`,
                `${name} won. The universe permits this. The cat permitted it first.`,
                `${name} added one win and approximately twelve zoomies.`,
            ],
            matchBigLoss: ({ name, streak }) => [
                `${name} is ${Math.abs(streak)} losses deep. Suggestion: mercy rule and a warm lap.`,
                `${name} requested a tactical box and no follow-up questions.`,
                `${name} insists this is an extremely long training montage in the sunbeam.`,
                `${name} is building character. So much character. Very judgmental eyes.`,
            ],
            matchColdLoss: ({ name }) => [
                `${name} is Frosty. Warm-up laps, snacks, and a tiny scarf prescribed.`,
                `${name} filed a formal complaint against matchmaking. In meows. Loud ones.`,
                `${name} needs encouragement, premium fuel, and perhaps a tiny sweater.`,
                `${name} is chilly. Emotionally. Fur helps. Attitude does not.`,
            ],
            matchMultiLoss: ({ name, losses }) => [
                `${name} survived ${losses} learning opportunities at cat speed.`,
                `${name} lost ${losses}, but the pride is still emotionally attached.`,
                `${name} calls those ${losses} losses "extensive field research."`,
                `${name} logged ${losses} Ls into the shame ledger. Ledger was knocked off the table.`,
            ],
            matchLoss: ({ name }) => [
                `${name} hit a learning opportunity at supersonic meow.`,
                `${name} lost. Blames physics. And that one laser pointer distraction.`,
                `${name} took an L. Happens to the best of legends.`,
                `${name} dropped a match. Match landed softly. Then got batted under the couch.`,
            ],
            matchMixed: ({ name, wins, losses }) => [
                `${name} processed ${wins}W/${losses}L and now requires a tiny spreadsheet of naps.`,
                `${name} went ${wins}-${losses}. Vibes: mixed treats.`,
                `${name} had a bipartisan session. Party animals / house cats only.`,
                `${name} banked wins AND losses. Equal-opportunity pride.`,
            ],
        },
    };

    function buddyStatusLines(kind, ctx = {}) {
        const skin = currentBuddySkin();
        const pack = BUDDY_SKIN_VOICE[skin.id];
        const make = pack && pack[kind];
        if (!make) return null;
        const name = ctx.name || buddyDisplayName();
        return make({
            name,
            label: skin.label,
            streak: ctx.streak ?? 0,
            wins: ctx.wins ?? 0,
            losses: ctx.losses ?? 0,
            stageName: ctx.stageName || "",
            skin,
        });
    }

    const atlasIconHtml = () => `<img src="${ATLAS_ICON_URL}" alt="" style="height:16px;width:16px;vertical-align:middle;margin-right:4px;object-fit:contain;">`;

    // buddyMood() keys -> sheet mood block names
    const BUDDY_MOOD_SPRITE = {
        focused: "idle",
        onFire: "onFire",
        frosty: "frosty",
        sleepy: "sleepy",
        neglected: "neglected",
    };

    const buddySheetLoadStateBySkin = Object.create(null); // skinId -> idle|loading|ready|failed
    function getBuddySkin(skinId) {
        const id = skinId && BUDDY_SKINS[skinId] ? skinId : "classic";
        return BUDDY_SKINS[id];
    }
    function currentBuddySkin() {
        ensureBuddy();
        const skin = getBuddySkin(buddyState.skinId);
        if (buddyState.skinId !== skin.id) {
            buddyState.skinId = skin.id;
            saveBuddyState();
        }
        return skin;
    }
    function buddySheetLoadStateFor(skinId) {
        return buddySheetLoadStateBySkin[skinId] || "idle";
    }
    function buddySheetCssUrl(sheetUrl) {
        // Single quotes inside url() so this is safe in HTML style="..." attributes.
        return `url('${sheetUrl}')`;
    }
    function applyBuddySpriteSheet(el, sheetUrl) {
        if (!el) return;
        el.classList.remove("is-fallback");
        el.style.setProperty("--rb-sheet-url", buddySheetCssUrl(sheetUrl));
        el.textContent = "";
    }
    function ensureBuddySheetLoaded(skinId) {
        const skin = getBuddySkin(skinId || buddyState?.skinId);
        const current = buddySheetLoadStateFor(skin.id);
        if (current === "loading" || current === "ready") return;
        buddySheetLoadStateBySkin[skin.id] = "loading";
        const img = new Image();
        const finish = state => {
            buddySheetLoadStateBySkin[skin.id] = state;
            const activeId = buddyState?.skinId || "classic";
            if (skin.id !== activeId) return;
            const view = document.getElementById("rgBuddyView");
            const buddyHasFocus = !!(view && view.contains(document.activeElement));
            if (state === "ready") {
                // Swap emoji → sprite in place so a focused control doesn't leave the fallback stuck.
                applyBuddySpriteSheet(document.getElementById("rgBuddySprite"), skin.sheetUrl);
            }
            // repaint the toolbar button once the sheet is ready (or failed — keeps emoji fallback)
            refreshBuddyButtonIcon();
            if (view && view.style.display !== "none" && !buddyHasFocus) renderBuddyView();
            if (state === "ready" && buddyState?.equipped && lastKnownPlayerData) {
                if (buddyHasFocus) {
                    const flair = document.getElementById("rgBuddyEquippedFlair");
                    if (flair) flair.innerHTML = buddyMiniVisualHtml(buddyStage());
                } else {
                    updateHUD(lastKnownPlayerData);
                }
            }
        };
        img.onload = () => finish("ready");
        img.onerror = () => finish("failed");
        img.referrerPolicy = "no-referrer";
        img.src = skin.sheetUrl;
    }

    function ensureBuddySpriteStyles() {
        if (document.getElementById("rgBuddySpriteStyle")) return;
        const style = document.createElement("style");
        style.id = "rgBuddySpriteStyle";
        style.textContent = `
.rg-buddy-sprite {
  --rb-tile: 112px;
  --rb-sheet-w: 2240px; /* 2560 * (112/128) */
  --rb-sheet-h: 560px;  /* 640 * (112/128) */
  --rb-mood: 0;
  --rb-stage: 0;
  --rb-sheet-url: none;
  width: var(--rb-tile);
  height: var(--rb-tile);
  display: inline-block;
  flex-shrink: 0;
  background-image: var(--rb-sheet-url);
  background-repeat: no-repeat;
  background-size: var(--rb-sheet-w) var(--rb-sheet-h);
  background-position-x: calc(var(--rb-mood) * -4 * var(--rb-tile));
  background-position-y: calc(var(--rb-stage) * -1 * var(--rb-tile));
  animation: rg-buddy-steps 600ms steps(4) infinite;
  transform: translateZ(0);
}
@keyframes rg-buddy-steps {
  from { background-position-x: calc(var(--rb-mood) * -4 * var(--rb-tile)); }
  to   { background-position-x: calc(var(--rb-mood) * -4 * var(--rb-tile) - 4 * var(--rb-tile)); }
}
.rg-buddy-sprite.stage-1 { --rb-stage: 0; }
.rg-buddy-sprite.stage-2 { --rb-stage: 1; }
.rg-buddy-sprite.stage-3 { --rb-stage: 2; }
.rg-buddy-sprite.stage-4 { --rb-stage: 3; }
.rg-buddy-sprite.stage-5 { --rb-stage: 4; }
.rg-buddy-sprite.mood-idle { --rb-mood: 0; }
.rg-buddy-sprite.mood-onFire { --rb-mood: 1; }
.rg-buddy-sprite.mood-frosty { --rb-mood: 2; }
.rg-buddy-sprite.mood-sleepy { --rb-mood: 3; }
.rg-buddy-sprite.mood-neglected { --rb-mood: 4; }
.rg-buddy-sprite.is-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-image: none;
  animation: none;
  font-size: 56px;
  line-height: 1;
}
.rg-buddy-mini {
  --rb-mini-stage: 0;
  --rb-sheet-url: none;
  width: 20px;
  height: 20px;
  display: inline-block;
  vertical-align: middle;
  background-image: var(--rb-sheet-url);
  background-repeat: no-repeat;
  background-size: 400px 100px;
  background-position: 0 calc(var(--rb-mini-stage) * -20px);
}
/* buddy avatar for the toolbar button. same sheet as the big view, scaled down. */
.rg-buddy-btn-icon {
  --rb-bi-stage: 0;
  --rb-sheet-url: none;
  width: 20px;
  height: 20px;
  display: block;
  background-image: var(--rb-sheet-url);
  background-repeat: no-repeat;
  background-size: 400px 100px;
  background-position-x: 0;
  background-position-y: calc(var(--rb-bi-stage) * -20px);
  animation: rg-buddy-btn-steps 600ms steps(4) infinite;
  image-rendering: pixelated;
}
@keyframes rg-buddy-btn-steps {
  from { background-position-x: 0; }
  to   { background-position-x: -80px; }
}
@media (prefers-reduced-motion: reduce) {
  .rg-buddy-btn-icon { animation: none; }
}
.rg-buddy-skin-select {
  width: 100%;
  margin-top: 4px;
  background: #0c1218;
  color: #e8f2f8;
  border: 1px solid #00bfff55;
  border-radius: 6px;
  padding: 5px 6px;
  font-size: 11px;
}
@media (prefers-reduced-motion: reduce) {
  .rg-buddy-sprite { animation: none; }
}
`;
        document.head.appendChild(style);
    }

    // ---------- Settings (persisted in localStorage) ----------

    const DEFAULT_SETTINGS = {
        glowEnabled: true,
        glowSpeed: 5,        // 1-10, higher = faster
        glowOpacity: 0.6,    // vibrancy
        glowColor1: "#ff7a00",
        glowColor2: "#00d4ff",
        // brings back the old 🚀 Rocket Goal HUD title
        ogTitle: false,
        // false hides the buddy button from the toolbar
        buddyEnabled: true,
    };

    let settings = { ...DEFAULT_SETTINGS };
    try {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("rgHudSettings") ?? "{}") };
    } catch (e) {
        pushError(e, "loadSettings");
    }

    function saveSettings() {
        try { localStorage.setItem("rgHudSettings", JSON.stringify(settings)); }
        catch (e) { pushError(e, "saveSettings"); }
    }

    function hexToRgba(hex, alpha) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!m) return hex;
        return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
    }

    function applyGlowSettings() {
        if (!hud) return;
        let styleEl = document.getElementById("rgGlowStyle");
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = "rgGlowStyle";
            document.head.appendChild(styleEl);
        }

        if (!settings.glowEnabled) {
            styleEl.textContent = "";
            hud.style.animation = "none";
            hud.style.boxShadow = "0 0 15px #00bfff55";
            return;
        }

        const c1 = hexToRgba(settings.glowColor1, Math.min(1, settings.glowOpacity * momentumGlow.intensity));
        const c2 = hexToRgba(settings.glowColor2, Math.min(1, settings.glowOpacity * momentumGlow.intensity));
        const R = 8, BLUR = 14 * momentumGlow.intensity, SPREAD = 3 * momentumGlow.intensity;

        let frames = "";
        for (let i = 0; i <= 8; i++) {
            const pct = (i * 12.5).toFixed(1);
            const angle = (i / 8) * 2 * Math.PI;
            const x = (Math.cos(angle) * R).toFixed(1);
            const y = (Math.sin(angle) * R).toFixed(1);
            frames += `${pct}% { box-shadow: ${x}px ${y}px ${BLUR.toFixed(1)}px ${SPREAD.toFixed(1)}px ${c1}, ${-x}px ${-y}px ${BLUR.toFixed(1)}px ${SPREAD.toFixed(1)}px ${c2}; }\n`;
        }

        styleEl.textContent = `@keyframes rgGlowSpin {\n${frames}}`;
        // speed 1-10 -> ~20s..1.5s
        const baseDuration = 22 - (settings.glowSpeed * 2.05);
        const duration = baseDuration / momentumGlow.speedMult;
        hud.style.boxShadow = "";
        hud.style.animation = `rgGlowSpin ${duration.toFixed(2)}s linear infinite`;
    }

    // ---------- Device ID ----------
    // per-install UUID for blacklisting. resets if localStorage clears, so it's friction not a fortress.

    function getDeviceId() {
        let id = null;
        try { id = localStorage.getItem("rgHudDeviceId"); } catch (e) {}
        if (!id) {
            id = crypto.randomUUID?.()
                || (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12));
            try { localStorage.setItem("rgHudDeviceId", id); } catch (e) {}
        }
        return id;
    }

    // num form lets server rules do >= checks. never write 11.10 (parseFloat).
    const SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "14.3";
    const SCRIPT_VERSION_NUM = parseFloat(SCRIPT_VERSION) || 0;

    // ---------- HUD ----------

    function createHUD() {
        if (hud) return;

        hud = document.createElement("div");
        hud.id = "rgHUD";

        let pos = { top: "110px", left: "", right: "20px" };
        try {
            const saved = JSON.parse(localStorage.getItem("rgHudPos") ?? "null");
            if (saved && saved.top && saved.left) {
                pos = { top: saved.top, left: saved.left, right: "auto" };
            }
        } catch (e) {}

        hud.style.cssText = `
            position:fixed;
            top:${pos.top};
            ${pos.left ? `left:${pos.left};` : ""}
            right:${pos.right};
            width:max-content;
            min-width:250px;
            max-width:340px;
            background:rgba(18,18,22,.88);
            color:white;
            border:2px solid #00bfff;
            border-radius:12px;
            font-family:Arial,sans-serif;
            padding:10px;
            z-index:999999999;
            user-select:none;
        `;

        hud.innerHTML = `
            <style>
                #rgHUD .rgBtn {
                    flex: 1;
                    font-size: 11px;
                    padding: 6px 2px;
                    background: linear-gradient(180deg, #1c2b3a, #10181f);
                    color: #d7f3ff;
                    border: 1px solid #00bfff88;
                    border-radius: 6px;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
                }
                #rgHUD .rgBtn:hover {
                    background: linear-gradient(180deg, #26405a, #16222c);
                    border-color: #00bfff;
                }
                #rgHUD .rgBtn:active { transform: scale(0.96); }
                #rgHUD .rgIconBtn {
                    background: none;
                    border: 1px solid #00bfff88;
                    color: #00bfff;
                    border-radius: 4px;
                    width: 22px;
                    height: 22px;
                    font-size: 13px;
                    line-height: 1;
                    cursor: pointer;
                    flex-shrink: 0;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    text-align: center;
                }
                #rgHUD .rgSettingRow {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    margin: 5px 0;
                    font-size: 12px;
                }
                #rgHUD input[type="range"] { width: 110px; }
                /* scroll inside the HUD so buttons don't fall off the bottom */
                #rgBody { max-height: calc(100vh - 170px); overflow-y: auto; overflow-x: hidden; }
                #rgHUD input[type="color"] {
                    width: 30px; height: 20px; padding: 0; border: none; background: none; cursor: pointer;
                }
                #rgNameModal {
                    position: absolute;
                    inset: 0;
                    background: rgba(10,14,18,0.96);
                    border-radius: 10px;
                    display: none;
                    flex-direction: column;
                    justify-content: center;
                    gap: 8px;
                    padding: 14px;
                    z-index: 10;
                }
                #rgNameModal input[type="text"] {
                    background: #10181f;
                    border: 1px solid #00bfff88;
                    border-radius: 6px;
                    color: #d7f3ff;
                    padding: 6px 8px;
                    font-size: 13px;
                    outline: none;
                    user-select: text;
                    -webkit-user-select: text;
                }
                #rgNameError { color: #ff6b6b; font-size: 11px; min-height: 14px; }
                #rgToast {
                    position: absolute;
                    left: 10px; right: 10px; bottom: 10px;
                    background: linear-gradient(180deg, #1c2b3a, #0d141b);
                    border: 1px solid #00bfff;
                    border-radius: 8px;
                    color: #d7f3ff;
                    font-size: 12px;
                    text-align: center;
                    padding: 8px 10px;
                    opacity: 0;
                    transition: opacity 0.2s ease, transform 0.2s ease;
                    transform: translateY(8px);
                    pointer-events: none;
                    z-index: 20;
                }
                #rgDialog {
                    position: absolute;
                    inset: 0;
                    background: rgba(10,14,18,0.96);
                    border-radius: 10px;
                    display: none;
                    flex-direction: column;
                    justify-content: center;
                    gap: 8px;
                    padding: 14px;
                    z-index: 30;
                }
                #rgDialog .rgDlgMsg { font-size: 13px; color: #d7f3ff; }
                #rgDialog input[type="text"] {
                    background: #10181f; border: 1px solid #00bfff88; border-radius: 6px;
                    color: #d7f3ff; padding: 6px 8px; font-size: 13px; outline: none;
                    user-select: text; -webkit-user-select: text;
                }
                #rgTooltip {
                    position: fixed;
                    z-index: 9999999999;
                    background: linear-gradient(180deg, #1c2b3a, #0d141b);
                    color: #d7f3ff;
                    border: 1px solid #00bfff;
                    border-radius: 6px;
                    padding: 5px 9px;
                    font-family: Arial, sans-serif;
                    font-size: 11px;
                    font-weight: bold;
                    white-space: nowrap;
                    pointer-events: none;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.5);
                    opacity: 0;
                    transition: opacity 0.12s ease;
                }
                #rgHUD .rgHasTip { cursor: help; border-bottom: 1px dotted currentColor; }
                #rgHUD .rgNoUnderline { border-bottom: none; }
            </style>
            <div style="display:flex;align-items:center;justify-content:space-between;cursor:move;gap:8px;" id="rgDragHandle">
                <span id="rgTitle" style="font-size:16px;font-weight:bold;color:#00bfff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><img src="${ATLAS_ICON_URL}" alt="" style="height:16px;width:16px;vertical-align:middle;margin-right:4px;object-fit:contain;">ATLAS</span>
                <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
                    <span id="rgErrDot" title="" style="display:none;color:#ff5555;font-weight:bold;font-size:14px;">⚠</span>
                    <span id="rgWarnDot" title="" style="display:none;color:#ffbb33;font-weight:bold;font-size:14px;cursor:help;" data-tip="ATLAS saw something unexpected (hover for details, or run rgDump() for full log)">⚑</span>
                    <button id="rgClanBtn" class="rgIconBtn" title="Clans">🛡️</button>
                    <button id="rgForgeBtn" class="rgIconBtn" title="Name Forge">🎨</button>
                    <button id="rgBuddyBtn" class="rgIconBtn" title="Rocket Buddy" aria-label="Rocket Buddy" aria-controls="rgBuddyView" aria-expanded="false">🚗</button>
                    <button id="rgSettingsBtn" class="rgIconBtn" title="Settings">⚙</button>
                    <button id="rgMinimize" class="rgIconBtn" title="Minimize">–</button>
                </div>
            </div>
            <hr>
            <div id="rgBody">
                <div id="rgStatsView">
                    <div id="rgContent">Waiting for data...</div>
                    <div id="rgSettingsPanel" style="display:none;border-top:1px solid #00bfff44;margin-top:8px;padding-top:6px;">
                        <div class="rgSettingRow"><span title="Bring back the original 🚀 Rocket Goal HUD title">OG Title</span><input type="checkbox" id="rgSetOgTitle"></div>
                        <div class="rgSettingRow"><span title="Toggle the Rocket Buddy button in the toolbar">Show Rocket Buddy</span><input type="checkbox" id="rgSetBuddyEnabled"></div>
                        <div class="rgSettingRow"><span>Glow</span><input type="checkbox" id="rgSetGlow"></div>
                        <div class="rgSettingRow"><span>Speed</span><input type="range" id="rgSetSpeed" min="1" max="10" step="0.5"></div>
                        <div class="rgSettingRow"><span>Vibrancy</span><input type="range" id="rgSetOpacity" min="0.1" max="1" step="0.05"></div>
                        <div class="rgSettingRow"><span>Color 1</span><input type="color" id="rgSetColor1"></div>
                        <div class="rgSettingRow"><span>Color 2</span><input type="color" id="rgSetColor2"></div>
                        <button id="rgSetReset" class="rgBtn" style="width:100%;margin-top:4px;">Reset to defaults</button>
                        <button id="rgSetRecap" class="rgBtn" style="width:100%;margin-top:4px;">📊 Session recap</button>
                        <button id="rgSetCopyDebug" class="rgBtn" style="width:100%;margin-top:4px;">📋 Copy debug bundle</button>
                    </div>
                </div>
                <div id="rgClanView" style="display:none;">Loading clans...</div>
                <div id="rgForgeView" style="display:none;max-height:520px;overflow-y:auto;overflow-x:hidden;"></div>
                <div id="rgBuddyView" style="display:none;"></div>
                <div id="rgActionRow" style="margin-top:6px;display:flex;gap:4px;">
                    <button id="rgRename" class="rgBtn" style="flex:1;">✏️ Rename</button>
                    <button id="rgSub" class="rgBtn" style="flex:1;">📺 Sub</button>
                    <button id="rgLeaderboard" class="rgBtn" style="flex:2;">🏆 Leaderboard</button>
                </div>
            </div>
            <div id="rgNameModal">
                <div id="rgNameTitle" style="font-size:13px;font-weight:bold;color:#00bfff;"></div>
                <input type="text" id="rgNameInput" maxlength="15">
                <div id="rgNameError"></div>
                <div style="display:flex;gap:6px;">
                    <button id="rgNameSave" class="rgBtn">Save</button>
                    <button id="rgNameCancel" class="rgBtn">Cancel</button>
                </div>
            </div>
            <div id="rgDialog" role="dialog" aria-modal="true" aria-labelledby="rgDialogMsg">
                <div id="rgDialogMsg" class="rgDlgMsg"></div>
                <input type="text" id="rgDialogInput" style="display:none;" maxlength="200">
                <div style="display:flex;gap:6px;">
                    <button id="rgDialogOk" class="rgBtn">OK</button>
                    <button id="rgDialogCancel" class="rgBtn">Cancel</button>
                </div>
            </div>
            <div id="rgToast" role="status" aria-live="polite" aria-atomic="true"></div>
        `;

        document.body.appendChild(hud);
        clampHudOnScreen();
        window.addEventListener("resize", clampHudOnScreen);
        dragElement(hud, document.getElementById("rgDragHandle"));
        applyGlowSettings();

        // one shared tooltip, replaces native title=
        let tooltipEl = document.getElementById("rgTooltip");
        if (!tooltipEl) {
            tooltipEl = document.createElement("div");
            tooltipEl.id = "rgTooltip";
            document.body.appendChild(tooltipEl);
        }
        hud.addEventListener("mouseover", e => {
            const target = e.target.closest("[data-tip]");
            if (!target) return;
            tooltipEl.textContent = target.getAttribute("data-tip");
            tooltipEl.style.opacity = "1";
        });
        hud.addEventListener("mousemove", e => {
            if (tooltipEl.style.opacity !== "1") return;
            // above-right of cursor, kept on-screen
            const pad = 14;
            let x = e.clientX + pad;
            let y = e.clientY - tooltipEl.offsetHeight - 6;
            if (x + tooltipEl.offsetWidth > window.innerWidth) x = e.clientX - tooltipEl.offsetWidth - pad;
            if (y < 0) y = e.clientY + pad;
            tooltipEl.style.left = x + "px";
            tooltipEl.style.top = y + "px";
        });
        hud.addEventListener("mouseout", e => {
            const target = e.target.closest("[data-tip]");
            if (target) tooltipEl.style.opacity = "0";
        });
        // re-renders can yank the hovered element mid-hover
        hud.addEventListener("mouseleave", () => {
            tooltipEl.style.opacity = "0";
        });

        // v13.6: blur buttons on mouse click so spacebar in queue hits the game
        // not the last tab. keyboard clicks (detail === 0) keep focus for tab flow.
        hud.addEventListener("click", (e) => {
            const btn = e.target.closest("button");
            if (btn && e.detail !== 0) btn.blur();
        });

        document.getElementById("rgMinimize").onclick = () => manualToggle();
        document.getElementById("rgSub").onclick = () => {
            window.open("https://www.youtube.com/@RootedEngineering", "_blank", "noopener");
        };
        document.getElementById("rgLeaderboard").onclick = () => {
            const onClanTab = document.getElementById("rgClanView")?.style.display !== "none";
            const url = onClanTab
                ? "https://wiljdaws.github.io/RG_Clan_Leaderboard/"
                : "https://abuarqob.github.io/rgleaderboard/";
            window.open(url, "_blank", "noopener");
        };
        document.getElementById("rgRename").onclick = () => {
            dbg(`Rename me clicked (hasPlayer=${!!lastKnownPlayerData})`);
            if (!lastKnownPlayerData) {
                showNameModal("Play a match or log in first!", "", false, () => {});
                hideNameModalSoon();
                return;
            }
            forceRenamePrompt = true;
            submitToLeaderboard(lastKnownPlayerData);
        };

        const statsView = document.getElementById("rgStatsView");
        const clanView = document.getElementById("rgClanView");
        const panel = document.getElementById("rgSettingsPanel");
        const forgeView = document.getElementById("rgForgeView");
        const buddyView = document.getElementById("rgBuddyView");
        const buddyBtn = document.getElementById("rgBuddyBtn");
        const body = document.getElementById("rgBody");
        const actionRow = document.getElementById("rgActionRow");
        function showStatsOnly() {
            clanView.style.display = "none";
            forgeView.style.display = "none";
            buddyView.style.display = "none";
            buddyBtn.setAttribute("aria-expanded", "false");
            panel.style.display = "none";
            statsView.style.display = "block";
            actionRow.style.display = "flex";
            body.scrollTop = 0;
            stopBuddyRefreshTimer();
            // drop clan listener when nobody's looking
            detachClanListener();
        }
        document.getElementById("rgClanBtn").onclick = () => {
            const showingClan = clanView.style.display !== "none";
            dbg(`Clan panel ${showingClan ? "closed" : "opened"}`);
            if (showingClan) { showStatsOnly(); return; }
            showStatsOnly();
            statsView.style.display = "none";
            clanView.style.display = "block";
            renderClanView(); // listener attaches once myClan is known
        };

        document.getElementById("rgForgeBtn").onclick = () => {
            const showingForge = forgeView.style.display !== "none";
            dbg(`Forge panel ${showingForge ? "closed" : "opened"}`);
            if (showingForge) { showStatsOnly(); return; }
            showStatsOnly();
            statsView.style.display = "none";
            forgeView.style.display = "block";
            actionRow.style.display = "none"; // hide leaderboard/sub in forge
            if (RGNF.setPrefixProvider) RGNF.setPrefixProvider(getClanTagPrefix);
            // imposter roster: last game's players minus you, minus profanity
            if (RGNF.setRosterProvider) RGNF.setRosterProvider(
                () => lastGamePlayers
                    .filter(p => !p.uid || p.uid !== myUserId())
                    .filter(p => p.name !== (lastKnownPlayerData?.Nickname ?? ""))
                    .filter(p => !containsProfanity(p.name.replace(/<[^>]*>/g, "")))
                    .map(p => p.name)
            );
            // fresh install / cached state can otherwise greet the wrong name
            if (RGNF.syncToCurrentPlayer) RGNF.syncToCurrentPlayer(myUserId(), myGameNamePlain() || myName(), stripLeadingClanTagMarkup(lastKnownPlayerData?.Nickname ?? ""));
            RGNF.mountIn(forgeView);
            // syncToCurrentPlayer only renders on account change
            if (RGNF.refresh) RGNF.refresh();
        };

        // Buddy tab, same pattern as Clan/Forge
        document.getElementById("rgBuddyBtn").onclick = () => {
            const showingBuddy = buddyView.style.display !== "none";
            dbg(`Buddy panel ${showingBuddy ? "closed" : "opened"}`);
            if (showingBuddy) { showStatsOnly(); return; }
            showStatsOnly();
            statsView.style.display = "none";
            buddyView.style.display = "block";
            buddyBtn.setAttribute("aria-expanded", "true");
            actionRow.style.display = "none";
            renderBuddyView();
            startBuddyRefreshTimer();
        };

        // hide the buddy button and shut its panel if it's open
        function applyBuddyVisibility() {
            const btn = document.getElementById("rgBuddyBtn");
            if (!btn) return;
            const enabled = settings.buddyEnabled !== false;
            btn.style.display = enabled ? "" : "none";
            if (!enabled && buddyView.style.display !== "none") showStatsOnly();
        }
        applyBuddyVisibility();
        refreshBuddyButtonIcon();
        ensureBuddySheetLoaded();

        // route through showStatsOnly so opening from Forge doesn't stack views
        document.getElementById("rgSettingsBtn").onclick = () => {
            const opening = panel.style.display === "none";
            dbg(`Settings panel ${opening ? "opened" : "closed"}`);
            showStatsOnly();
            if (opening) panel.style.display = "block";
        };

        const setGlow = document.getElementById("rgSetGlow");
        const setSpeed = document.getElementById("rgSetSpeed");
        const setOpacity = document.getElementById("rgSetOpacity");
        const setColor1 = document.getElementById("rgSetColor1");
        const setColor2 = document.getElementById("rgSetColor2");

        const setOgTitle = document.getElementById("rgSetOgTitle");
        const setBuddyEnabled = document.getElementById("rgSetBuddyEnabled");
        function syncSettingInputs() {
            setOgTitle.checked = !!settings.ogTitle;
            setBuddyEnabled.checked = settings.buddyEnabled !== false;
            setGlow.checked = settings.glowEnabled;
            setSpeed.value = settings.glowSpeed;
            setOpacity.value = settings.glowOpacity;
            setColor1.value = settings.glowColor1;
            setColor2.value = settings.glowColor2;
        }
        syncSettingInputs();

        setOgTitle.onchange = () => {
            settings.ogTitle = setOgTitle.checked;
            saveSettings();
            applyTitle();
        };
        setBuddyEnabled.onchange = () => {
            settings.buddyEnabled = setBuddyEnabled.checked;
            saveSettings();
            applyBuddyVisibility();
        };
        setGlow.onchange = () => { settings.glowEnabled = setGlow.checked; saveSettings(); applyGlowSettings(); };
        setSpeed.oninput = () => { settings.glowSpeed = parseFloat(setSpeed.value); saveSettings(); applyGlowSettings(); };
        setOpacity.oninput = () => { settings.glowOpacity = parseFloat(setOpacity.value); saveSettings(); applyGlowSettings(); };
        setColor1.oninput = () => { settings.glowColor1 = setColor1.value; saveSettings(); applyGlowSettings(); };
        setColor2.oninput = () => { settings.glowColor2 = setColor2.value; saveSettings(); applyGlowSettings(); };
        document.getElementById("rgSetReset").onclick = () => {
            dbg("Settings reset to defaults");
            settings = { ...DEFAULT_SETTINGS };
            saveSettings();
            syncSettingInputs();
            applyGlowSettings();
        };

        document.getElementById("rgSetRecap").onclick = () => {
            dbg("Session recap opened");
            showSessionRecap();
        };

        // trim player data, don't dump the whole login blob
        document.getElementById("rgSetCopyDebug").onclick = async () => {
            dbg("Copy debug bundle clicked");
            try {
                const trimmedPlayer = lastKnownPlayerData ? {
                    Id: lastKnownPlayerData.Id,
                    Nickname: lastKnownPlayerData.Nickname,
                    ModesGlicko: lastKnownPlayerData.ModesGlicko,
                    ModesData: lastKnownPlayerData.ModesData,
                } : null;
                // Trimmed so we see the important bits without dumping every
                // per-account match-total we've ever tracked.
                const trimmedBuddy = buddyState ? {
                    schemaVersion: buddyState.schemaVersion,
                    name: buddyState.name,
                    skinId: buddyState.skinId,
                    equipped: buddyState.equipped,
                    matchesDriven: buddyState.matchesDriven,
                    birthAt: buddyState.birthAt,
                    lastPetAt: buddyState.lastPetAt,
                    lastMatchAt: buddyState.lastMatchAt,
                    lastMoodKey: buddyState.lastMoodKey,
                    lastSeenStage: buddyState.lastSeenStage,
                    lastStatus: buddyState.lastStatus,
                    lastStatusAt: buddyState.lastStatusAt,
                    bestRankByMode: buddyState.bestRankByMode,
                    accountKeys: Object.keys(buddyState.accountMatchTotals || {}).length,
                } : null;
                // Snapshot of what the user is looking at right now — tells us
                // whether the buddy view / a dialog was even visible when a
                // click didn't work.
                const ui = (() => {
                    const q = id => document.getElementById(id);
                    const visible = el => !!(el && el.style.display !== "none");
                    const dlg = q("rgDialog");
                    return {
                        hudExists: !!q("rgHud"),
                        buddyBtnExists: !!q("rgBuddyBtn"),
                        buddyViewOpen: visible(q("rgBuddyView")),
                        clanViewOpen: visible(q("rgClanView")),
                        forgeViewOpen: visible(q("rgForgeView")),
                        settingsOpen: visible(q("rgSettingsPanel")),
                        dialogOpen: dlg && dlg.style.display === "flex",
                        buddyRenameBtn: !!q("rgBuddyRename"),
                        buddySkinSelect: !!q("rgBuddySkin"),
                    };
                })();
                // Basic device fingerprint — tells us if a report is from
                // mobile Safari vs desktop Chrome, tiny viewport, etc.
                const device = (() => {
                    const n = typeof navigator !== "undefined" ? navigator : {};
                    const s = typeof screen !== "undefined" ? screen : {};
                    return {
                        userAgent: n.userAgent || "",
                        platform: n.platform || "",
                        language: n.language || "",
                        touch: (n.maxTouchPoints ?? 0) > 0,
                        screen: `${s.width || 0}x${s.height || 0}`,
                        viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
                        pixelRatio: window.devicePixelRatio || 1,
                    };
                })();
                const bundle = {
                    version: SCRIPT_VERSION,
                    versionNum: SCRIPT_VERSION_NUM,
                    deviceId: getDeviceId(),
                    device,
                    timestamp: new Date().toISOString(),
                    settings: settings,
                    player: trimmedPlayer,
                    state: {
                        _inMatch,
                        _liveRoster: _liveRoster.length,
                        lastGamePlayers: lastGamePlayers.length,
                        _lastInitLineAt,
                        _lastRecoverySignalAt,
                        _lastValidRatingsAt,
                    },
                    buddy: trimmedBuddy,
                    ui,
                    clan: myClan ? {
                        id: myClan.id,
                        name: myClan.name,
                        tag: myClan.tag,
                        role: myClanRole?.(),
                        memberCount: (myClan.members || []).length,
                        eventScore: computeClanEventScore(myClan),
                    } : null,
                    event: eventConfig ? {
                        name: eventConfig.name,
                        phase: eventPhase(),
                    } : null,
                    warnings: _rgWarnBuf,
                    errors: _rgErrorBuf,
                    log: _rgLogBuf.slice(-100),
                };
                await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
                showToast("Debug bundle copied — paste it in a bug report");
            } catch (e) {
                pushError(e, "copyDebugBundle");
                console.error("[RG HUD] Copy debug bundle failed:", e);
                showToast("Copy failed — see console");
            }
        };

        // handler early-returns when no banner is up
        if (!countdownIntervalId) {
            countdownIntervalId = setInterval(tickCountdown, 1000);
        }
    }

    function clampHudOnScreen() {
        if (!hud) return;
        // hidden HUD returns zeros from getBoundingClientRect and we'd persist
        // top-left as the "corrected" pos. setAutoVisible re-clamps on show.
        if (hud.style.display === "none" || hud.offsetWidth === 0) return;
        const rect = hud.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const MARGIN = 40;

        let left = rect.left;
        let top = rect.top;

        if (left + rect.width < MARGIN) left = MARGIN - rect.width;
        if (left > vw - MARGIN) left = vw - MARGIN;
        if (top < 0) top = 0;
        if (top > vh - MARGIN) top = vh - MARGIN;

        if (left !== rect.left || top !== rect.top) {
            hud.style.left = left + "px";
            hud.style.top = top + "px";
            hud.style.right = "auto";
            try {
                localStorage.setItem("rgHudPos", JSON.stringify({
                    top: hud.style.top,
                    left: hud.style.left,
                }));
            } catch (e) {}
        }
    }

    function dragElement(el, handle) {
        let dx = 0, dy = 0;

        handle.onmousedown = e => {
            if (e.target.closest(".rgIconBtn")) return;
            e.preventDefault();
            dx = e.clientX;
            dy = e.clientY;
            document.onmousemove = drag;
            document.onmouseup = () => {
                document.onmousemove = null;
                document.onmouseup = null;
                try {
                    localStorage.setItem("rgHudPos", JSON.stringify({
                        top: el.style.top,
                        left: el.style.left,
                    }));
                } catch (err) {}
            };
        };

        function drag(e) {
            e.preventDefault();
            const moveX = dx - e.clientX;
            const moveY = dy - e.clientY;
            dx = e.clientX;
            dy = e.clientY;
            // title bar is the only drag handle, off-screen = stranded til reload
            const MARGIN = 40;
            let newTop = el.offsetTop - moveY;
            let newLeft = el.offsetLeft - moveX;
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - MARGIN));
            newLeft = Math.max(MARGIN - el.offsetWidth, Math.min(newLeft, window.innerWidth - MARGIN));
            el.style.top = newTop + "px";
            el.style.left = newLeft + "px";
            el.style.right = "auto";
        }
    }

    function manualToggle() {
        const body = document.getElementById("rgBody");
        const visible = body.style.display !== "none";
        body.style.display = visible ? "none" : "block";
        document.getElementById("rgMinimize").textContent = visible ? "+" : "–";
        document.getElementById("rgMinimize").title = visible ? "Restore" : "Minimize";
    }

    function setAutoVisible(visible) {
        if (!hud) return;
        hud.style.display = visible ? "block" : "none";
        if (!visible) {
            // tooltip lives on body, hide it or it strands over the game
            const tip = document.getElementById("rgTooltip");
            if (tip) tip.style.opacity = "0";
        }
        // window may have resized while hidden
        if (visible) clampHudOnScreen();
    }

    // ---------- Error indicator ----------

    function showError(message) {
        const dot = document.getElementById("rgErrDot");
        if (dot) {
            dot.style.display = "inline";
            dot.title = message;
        }
    }

    function clearError() {
        const dot = document.getElementById("rgErrDot");
        if (dot) dot.style.display = "none";
    }

    // ---------- Win/loss streak tracking ----------
    // game only gives cumulative totals, diff between updates to get per-match.
    // +ve = win streak, -ve = loss streak. resets on account change / session end.

    let streakData = null;
    try { streakData = JSON.parse(localStorage.getItem("rgHudStreak") ?? "null"); }
    catch (e) { pushError(e, "loadStreak"); }

    function saveStreak() {
        try { localStorage.setItem("rgHudStreak", JSON.stringify(streakData)); }
        catch (e) { pushError(e, "saveStreak"); }
    }

    function resetStreak(accountId, totalWins, totalMatches) {
        streakData = { accountId, streak: 0, lastWins: totalWins, lastMatches: totalMatches };
        saveStreak();
    }

    function updateStreak(data) {
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        // first observation, baseline only
        if (!streakData || streakData.accountId !== data.Id) {
            resetStreak(data.Id, totalWins, totalMatches);
            return;
        }

        const matchDiff = totalMatches - streakData.lastMatches;
        const winDiff = totalWins - streakData.lastWins;

        if (matchDiff <= 0) return;

        // can't know the interleaving. pure blocks stay as blocks, mixed collapses to net sign mag 1
        const losses = matchDiff - winDiff;
        if (winDiff > 0 && losses === 0) {
            streakData.streak = streakData.streak > 0 ? streakData.streak + winDiff : winDiff;
        } else if (losses > 0 && winDiff === 0) {
            streakData.streak = streakData.streak < 0 ? streakData.streak - losses : -losses;
        } else {
            streakData.streak = winDiff >= losses ? 1 : -1;
        }

        streakData.lastWins = totalWins;
        streakData.lastMatches = totalMatches;
        saveStreak();
        return {
            matches: matchDiff,
            wins: Math.max(0, Math.min(matchDiff, winDiff)),
            losses: Math.max(0, Math.min(matchDiff, losses)),
            streak: streakData.streak,
        };
    }

    function streakBadge() {
        if (!streakData || streakData.streak === 0) return "";
        const n = streakData.streak;
        if (n > 0) {
            return `<span class="rgHasTip rgNoUnderline" data-tip="${n}-win streak this session" style="color:#ff7a00;font-weight:bold;">🔥x${n}</span>`;
        }
        return `<span class="rgHasTip rgNoUnderline" data-tip="${-n}-loss streak this session" style="color:#7ec8ff;font-weight:bold;">❄️x${-n}</span>`;
    }

    // ---------- Session deltas ----------

    // one continuous play run. resets on account change or after SESSION_IDLE_MS
    // localStorage + timestamp. refresh keeps it, overnight starts fresh.
    const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2h

    let sessionStart = null;
    try { sessionStart = JSON.parse(localStorage.getItem("rgHudSessionStart") ?? "null"); }
    catch (e) { pushError(e, "loadSessionStart"); }

    function captureSessionStart(data) {
        const now = Date.now();
        const sameAccount = sessionStart && sessionStart.accountId === data.Id;
        const idledOut = sessionStart && (now - (sessionStart.lastSeen ?? 0)) > SESSION_IDLE_MS;

        if (sameAccount && !idledOut) {
            // same session, bump timestamp
            sessionStart.lastSeen = now;
            try { localStorage.setItem("rgHudSessionStart", JSON.stringify(sessionStart)); }
            catch (e) { pushError(e, "saveSessionStart"); }
            return;
        }

        // new session, fresh baseline, drop inherited momentum
        sessionStart = {
            accountId: data.Id,
            startedAt: now,
            lastSeen: now,
            Competitive3v3: data.ModesGlicko?.Competitive3v3?.displayRating ?? null,
            Competitive2v2: data.ModesGlicko?.Competitive2v2?.displayRating ?? null,
            Competitive1v1: data.ModesGlicko?.Competitive1v1?.displayRating ?? null,
            Casual: data.ModesGlicko?.Casual?.displayRating ?? null,
        };
        try { localStorage.setItem("rgHudSessionStart", JSON.stringify(sessionStart)); } catch (e) {}
        currentMomentumState = "neutral";

        // reset streak, don't count pre-session matches
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const tw = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
        const tm = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);
        resetStreak(data.Id, tw, tm);

        // bust clan cache on account change
        clanLoaded = false;
        clanLoadedForAccount = null;
        myClan = null;
        checkClanNotices();
        const clanView = document.getElementById("rgClanView");
        if (clanView && clanView.style.display !== "none") {
            renderClanView();
        }
    }

    function deltaBadge(mode, current) {
        if (!sessionStart || typeof current !== "number" || typeof sessionStart[mode] !== "number") return "";
        const diff = current - sessionStart[mode];
        if (diff === 0) return "";
        const color = diff > 0 ? "#00ff66" : "#ff6b6b";
        const sign = diff > 0 ? "+" : "";
        return ` <span style="color:${color};font-size:10px;">(${sign}${diff})</span>`;
    }

    // ---------- Rocket Buddy (v13.6) ----------
    // local-only tamagotchi. per-device not per-account. no Firestore.
    // stage gates: matches since install + rank floor at 3+. nothing retroactive.
    // Shared progression gates. Display names/icons come from the selected skin.
    const BUDDY_STAGE_GATES = [
        { id: 1, matches: 0,   rankTop: null },
        { id: 2, matches: 50,  rankTop: null },
        { id: 3, matches: 150, rankTop: 500 },
        { id: 4, matches: 400, rankTop: 100 },
        { id: 5, matches: 800, rankTop: 20  },
    ];
    // Back-compat alias — some helpers still read .length / index by id.
    const BUDDY_STAGES = BUDDY_STAGE_GATES;
    const BUDDY_PET_COOLDOWN_MS = 60 * 60 * 1000; // 1h between pets
    const BUDDY_STORAGE_KEY = "rgHudBuddy";
    const BUDDY_SCHEMA_VERSION = 4;

    let buddyState = null;
    let buddyRefreshTimer = null;
    try { buddyState = JSON.parse(localStorage.getItem(BUDDY_STORAGE_KEY) ?? "null"); }
    catch (e) { pushError(e, "loadBuddyState"); }

    function saveBuddyState() {
        try { localStorage.setItem(BUDDY_STORAGE_KEY, JSON.stringify(buddyState)); }
        catch (e) { pushError(e, "saveBuddyState"); }
    }

    function newBuddyState() {
        return {
            schemaVersion: BUDDY_SCHEMA_VERSION,
            name: "",
            birthAt: Date.now(),
            matchesDriven: 0,
            // back-compat with v1 saves. v2+ uses accountMatchTotals to avoid
            // account-switch inflation
            lifetimeMatchesAtBirth: null,
            accountMatchTotals: {},
            lastPetAt: 0,
            lastMatchAt: 0,
            equipped: false,
            bestRankByMode: {},
            lastSeenStage: null,
            lastStatus: "",
            lastStatusAt: 0,
            lastMoodKey: "focused",
            skinId: "classic",
        };
    }

    function ensureBuddy() {
        const defaults = newBuddyState();
        let changed = false;
        if (!buddyState || typeof buddyState !== "object" || Array.isArray(buddyState)) {
            buddyState = defaults;
            changed = true;
        } else {
            for (const [key, value] of Object.entries(defaults)) {
                if (buddyState[key] === undefined) {
                    buddyState[key] = value;
                    changed = true;
                }
            }
            if (!buddyState.accountMatchTotals || typeof buddyState.accountMatchTotals !== "object" || Array.isArray(buddyState.accountMatchTotals)) {
                buddyState.accountMatchTotals = {};
                changed = true;
            }
            if (!buddyState.bestRankByMode || typeof buddyState.bestRankByMode !== "object" || Array.isArray(buddyState.bestRankByMode)) {
                buddyState.bestRankByMode = {};
                changed = true;
            }
            if (buddyState.schemaVersion !== BUDDY_SCHEMA_VERSION) {
                buddyState.schemaVersion = BUDDY_SCHEMA_VERSION;
                changed = true;
            }
        }
        if (changed) {
            saveBuddyState();
        }
    }

    // called on every ratings sync
    function tickBuddyFromData(data) {
        ensureBuddy();
        if (!data || !data.ModesData) return;
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const total = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);
        const accountId = data.Id == null ? "" : String(data.Id);
        if (accountId) {
            const seen = buddyState.accountMatchTotals;
            if (!Object.prototype.hasOwnProperty.call(seen, accountId)) {
                // first sighting, baseline only, no retro credit
                seen[accountId] = total;
                if (buddyState.lifetimeMatchesAtBirth == null) buddyState.lifetimeMatchesAtBirth = total;
                saveBuddyState();
            } else {
                const previous = Number(seen[accountId]);
                if (Number.isFinite(previous) && total > previous) {
                    buddyState.matchesDriven += total - previous;
                    seen[accountId] = total;
                    buddyState.lastMatchAt = Date.now();
                    saveBuddyState();
                }
                // lower total = partial response. don't re-baseline or we double-count.
            }
        }
        // best-rank floor per mode
        const rankPlaylists = { "3v3": null, "2v2": null, "1v1": null };
        for (const p of Object.keys(rankPlaylists)) {
            const r = cachedRanks.get(p);
            if (typeof r === "number") {
                const prev = buddyState.bestRankByMode[p];
                if (prev == null || r < prev) {
                    buddyState.bestRankByMode[p] = r;
                    saveBuddyState();
                }
            }
        }
        const currentStage = buddyStage();
        if (buddyState.lastSeenStage == null) {
            buddyState.lastSeenStage = currentStage.level;
            saveBuddyState();
        } else if (currentStage.level > buddyState.lastSeenStage) {
            buddyState.lastSeenStage = currentStage.level;
            saveBuddyState();
            setBuddyStatus(pickBuddyLine(
                buddyStatusLines("evolve", { stageName: currentStage.name }) || [
                    `${buddyDisplayName()} evolved into ${currentStage.name}. The garage insurance premium just moved.`,
                    `${buddyDisplayName()} unlocked ${currentStage.name}! Please admire the new hardware responsibly.`,
                    `${buddyDisplayName()} evolved! Somewhere, a tiny mechanic is crying happy tears.`,
                ],
                currentStage.level
            ));
            showBanner(`🚀 ${currentStage.name.toUpperCase()} UNLOCKED!`, currentStage.level >= 4 ? "#ffd700" : "#00bfff");
        }
    }

    function buddyStage() {
        ensureBuddy();
        const skin = currentBuddySkin();
        const matches = buddyState.matchesDriven;
        const bestRank = Object.values(buddyState.bestRankByMode)
            .filter(r => typeof r === "number")
            .reduce((m, r) => Math.min(m, r), Infinity);
        // Walk from highest to lowest; return the first stage whose gates
        // this buddy has cleared. matches AND rank-floor (if any) both
        // must pass -- stages 3+ need both.
        for (let i = BUDDY_STAGE_GATES.length - 1; i >= 0; i--) {
            const gate = BUDDY_STAGE_GATES[i];
            const flavor = skin.stages[i] || skin.stages[0];
            const matchOk = matches >= gate.matches;
            const rankOk = gate.rankTop == null || bestRank <= gate.rankTop;
            if (matchOk && rankOk) {
                return {
                    id: gate.id,
                    level: gate.id,
                    matches: gate.matches,
                    rankTop: gate.rankTop,
                    name: flavor.name,
                    icon: flavor.icon,
                    bestRank,
                    skinId: skin.id,
                };
            }
        }
        const flavor = skin.stages[0];
        return {
            id: 1,
            level: 1,
            matches: 0,
            rankTop: null,
            name: flavor.name,
            icon: flavor.icon,
            bestRank,
            skinId: skin.id,
        };
    }

    // null when maxed
    function buddyNextStageRequirement() {
        const cur = buddyStage();
        if (cur.level >= BUDDY_STAGE_GATES.length) return null;
        const nextGate = BUDDY_STAGE_GATES[cur.level];
        const skin = currentBuddySkin();
        const nextFlavor = skin.stages[cur.level] || skin.stages[skin.stages.length - 1];
        const matchGap = Math.max(0, nextGate.matches - buddyState.matchesDriven);
        const rankGap = nextGate.rankTop == null || (cur.bestRank <= nextGate.rankTop)
            ? null
            : nextGate.rankTop;
        return { matches: matchGap, rankTop: rankGap, stageName: nextFlavor.name };
    }

    // streak + idle time. independent of stage.
    function buddyMood() {
        ensureBuddy();
        const now = Date.now();
        const idleMs = now - (buddyState.lastMatchAt || buddyState.birthAt);
        const streak = streakData?.streak ?? 0;
        if (streak >= 3)  return { key: "onFire",     label: "🔥 On fire",       color: "#ff7a00" };
        if (streak <= -3) return { key: "frosty",     label: "❄ Frosty",         color: "#7ec8ff" };
        if (idleMs > 3 * 24 * 3600 * 1000) return { key: "neglected", label: "😢 Neglected",  color: "#9aa5ad" };
        if (idleMs > 24 * 3600 * 1000)     return { key: "sleepy",    label: "💤 Sleepy",     color: "#6b8fb4" };
        return { key: "focused", label: "🎯 Focused", color: "#00bfff" };
    }

    // display only. 100 after match/pet, 0 after 24h idle.
    function buddyEnergy() {
        ensureBuddy();
        const now = Date.now();
        const anchor = Math.max(buddyState.lastPetAt || 0, buddyState.lastMatchAt || 0, buddyState.birthAt);
        const hoursIdle = (now - anchor) / (3600 * 1000);
        return Math.max(0, Math.min(100, Math.round(100 - hoursIdle * 4.17))); // 100 -> 0 over 24h
    }

    function buddyDisplayName() {
        return (buddyState?.name || "").trim() || "Unnamed";
    }

    function pickBuddyLine(lines, seed = 0) {
        const index = Math.abs(Number(seed) || 0) % lines.length;
        return lines[index];
    }

    function setBuddyStatus(message, notify = true) {
        ensureBuddy();
        buddyState.lastStatus = String(message);
        buddyState.lastStatusAt = Date.now();
        saveBuddyState();
        if (notify) showToast(buddyState.lastStatus);
    }

    function reportBuddyMoodTransition(mood) {
        ensureBuddy();
        if (!mood?.key || buddyState.lastMoodKey === mood.key) return;
        buddyState.lastMoodKey = mood.key;

        const name = buddyDisplayName();
        let lines = null;
        if (mood.key === "sleepy") {
            lines = buddyStatusLines("sleepy", { name }) || [
                `${name} entered sleep mode. Snoring is now available in surround sound.`,
                `${name} parked for a power nap and left the hazards on.`,
                `${name} is dreaming of unlimited boost and suspiciously large snacks.`,
            ];
        } else if (mood.key === "neglected") {
            lines = buddyStatusLines("neglected", { name }) || [
                `${name} has started collecting dust as a hobby. A pet might help.`,
                `${name} is composing a dramatic ballad titled "Where Did My Human Go?"`,
                `${name} checked the garage door again. Still no snacks.`,
            ];
        }

        if (lines) {
            setBuddyStatus(pickBuddyLine(lines, Math.floor(Date.now() / (24 * 3600 * 1000))));
        } else {
            saveBuddyState();
        }
    }

    function reportBuddyMatchStatus(result) {
        if (!result?.matches) return;
        ensureBuddy();
        const name = buddyDisplayName();
        const streak = result.streak ?? 0;
        let kind = "matchMixed";
        if (result.wins > 0 && result.losses === 0) {
            if (streak >= 8) kind = "matchBigWin";
            else if (streak >= 3) kind = "matchHotWin";
            else if (result.wins > 1) kind = "matchMultiWin";
            else kind = "matchWin";
        } else if (result.losses > 0 && result.wins === 0) {
            if (streak <= -8) kind = "matchBigLoss";
            else if (streak <= -3) kind = "matchColdLoss";
            else if (result.losses > 1) kind = "matchMultiLoss";
            else kind = "matchLoss";
        }

        let lines = buddyStatusLines(kind, {
            name,
            streak,
            wins: result.wins,
            losses: result.losses,
        });

        // Classic (and any skin without a voice pack) keeps the original garage lines.
        if (!lines) {
        if (result.wins > 0 && result.losses === 0) {
            if (streak >= 8) {
                lines = [
                    `${name} has forgotten how losing works. Please do not remind them.`,
                    `${name} is requesting a trophy-shaped parking spot.`,
                    `${name} has achieved dangerous levels of zoom.`,
                    `${name} is 8 wins deep. The other cars filed a restraining order.`,
                    `${name} is un-lose-able. This is a legal problem now.`,
                    `${name} has stopped acknowledging opponents as opponents.`,
                    `${name} is on the podium so often it has a favorite step.`,
                    `${name} has been offered an endorsement deal by boost.`,
                    `${name} is currently in the leaderboard hall of fame's group chat.`,
                    `${name} has weaponized momentum.`,
                    `${name} is now legally distinct from "the winner." They are winning itself.`,
                    `${name} has broken the sound barrier and possibly the ELO system.`,
                    `${name} has been asked to slow down. Politely declined.`,
                    `${name} skips warm-up because they were never cold to begin with.`,
                    `${name} is on a first-name basis with the trophy.`,
                    `${name} has entered a state scientists are calling "unhinged winning".`,
                    `${name} has stopped needing wheels. They just win.`,
                    `${name} has been added to the game's danger tips.`,
                    `${name} is currently rewriting the meta.`,
                    `${name} is speed. ${name} is destiny.`,
                    `${name} stopped tracking wins and started counting hostages.`,
                    `${name} was quietly banned from the practice server for scaring bots.`,
                    `${name} is 8-0 and asking if anyone brought snacks.`,
                    `${name} is playing a different game than everyone else.`,
                    `${name} has entered god mode. Disabling requires a support ticket.`,
                    `${name} is dominating so hard the leaderboard just typed "gg".`,
                    `${name} has been offered a sponsorship by pure oxygen.`,
                    `${name} has stopped losing. It's unclear what happens next.`,
                    `${name} is the reason "unfair" was invented.`,
                    `${name} has ascended to a plane matchmaking cannot follow.`,
                    `${name} is playing chess. Everyone else is losing checkers.`,
                    `${name} just hit ${Math.abs(streak)} wins straight. The referee is taking a lie-down.`,
                ];
            } else if (streak >= 3) {
                lines = [
                    `${name} is ON FIRE! Keep flammable decals at a safe distance.`,
                    `${name} is cooking. The recipe appears to be pure boost.`,
                    `${name} has entered main-character mode.`,
                    `${name} is heating up. Please open a window.`,
                    `${name} is on a roll. A very expensive one.`,
                    `${name} has achieved "runs stapled to backboard" confidence.`,
                    `${name} is winning at a rate that concerns the insurance company.`,
                    `${name} smells victory. Also gasoline.`,
                    `${name} is stacking Ws like it's a hobby.`,
                    `${name} is doing that thing. The winning thing.`,
                    `${name} is basically the villain in someone else's highlight reel.`,
                    `${name} is on a heater. Literally. Please check the engine.`,
                    `${name} is streaking, but in the wholesome car way.`,
                    `${name} is drafting the trophy speech mid-match.`,
                    `${name} is ${Math.abs(streak)} wins deep and unbearable already.`,
                    `${name} is having a moment. A loud, obnoxious moment.`,
                    `${name} has decided losing is not on today's schedule.`,
                    `${name} has entered the "delete lobby" phase of the day.`,
                    `${name} is smashing so hard opponents are quitting to Fortnite.`,
                    `${name} is playing like the win button is broken. Broken their way.`,
                    `${name} is on a mission. Mission unclear, but WINNING.`,
                    `${name} just clicked their heels three times. Home is a trophy.`,
                    `${name} is officially in the zone. Do not disturb the zone.`,
                    `${name} is gaslighting matchmaking in real time.`,
                    `${name} has that gleam in the headlights. Bad news for everyone.`,
                    `${name} is dishing out Ws like a school cafeteria.`,
                    `${name} is on fire and refuses to be extinguished.`,
                    `${name} is now a firework. Please stand back.`,
                    `${name} is playing on god-tier settings. Everyone else is on tutorial.`,
                    `${name} is running hot. Cooling system is failing gracefully.`,
                    `${name} is picking up steam. And wins.`,
                    `${name} is the reason opponents believe in conspiracy theories.`,
                ];
            } else if (result.wins > 1) {
                lines = [
                    `${name} banked ${result.wins} wins. Turbo confidence engaged.`,
                    `${name} collected ${result.wins} wins and would like them framed.`,
                    `${name} just speed-ran ${result.wins} victories. Very normal behavior.`,
                    `${name} bagged ${result.wins} in a row. The bag is starting to bulge.`,
                    `${name} racked up ${result.wins} wins. Loading additional swagger...`,
                    `${name} tossed ${result.wins} wins in the trunk. Room for more.`,
                    `${name} secured ${result.wins} wins and is now unbearable at dinner.`,
                    `${name} claimed ${result.wins} in a row. Ownership papers pending.`,
                    `${name} bulk-bought ${result.wins} wins. Costco energy.`,
                    `${name} chained ${result.wins} wins together. Chain restaurant of dominance.`,
                    `${name} pocketed ${result.wins} wins. They clink when walking.`,
                    `${name} stacked ${result.wins} wins. Stack structurally alarming.`,
                    `${name} won ${result.wins} in a row. Keyboard filed for hazard pay.`,
                    `${name} ran up ${result.wins} wins. Scoreboard is out of breath.`,
                    `${name} clocked ${result.wins} back-to-back wins. Timepiece unimpressed.`,
                    `${name} has ${result.wins} wins and zero regrets.`,
                    `${name} bagged ${result.wins}. Feel free to be impressed.`,
                    `${name} just did ${result.wins} in a row. Anyone need a witness?`,
                    `${name} logged ${result.wins} wins into the permanent record.`,
                    `${name} is up ${result.wins} matches. "Up" as in ascending.`,
                    `${name} handed out ${result.wins} losses. Return to sender.`,
                    `${name} rolled ${result.wins} wins. Vegas is watching.`,
                    `${name} popped ${result.wins} wins like it was a hobby.`,
                    `${name} bagged ${result.wins} wins with minimal drama.`,
                    `${name} strung ${result.wins} wins together. Whole vibe.`,
                    `${name} is ${result.wins}-0 and starting to feel it.`,
                    `${name} put ${result.wins} wins in the win jar. Jar overflowing.`,
                    `${name} did ${result.wins} wins. ${result.wins} more than the opponents.`,
                    `${name} tacked on ${result.wins} wins. Bulletin board is filling.`,
                    `${name} added ${result.wins} more Ws. Alphabet is out of Ls.`,
                    `${name} landed ${result.wins} wins in a row. Plane says "same."`,
                    `${name} closed out ${result.wins} matches. Books look good.`,
                ];
            } else {
                lines = [
                    `${name} is getting stronger! The garage is concerned.`,
                    `${name} added one win and approximately twelve horsepower.`,
                    `${name} found the boost button. This is getting dangerous.`,
                    `${name} says that was calculated. It was not.`,
                    `${name} snagged a W. Momentum: initialized.`,
                    `${name} pulled off a win. Nobody call it a fluke.`,
                    `${name} won. The universe permits this.`,
                    `${name} banked a win. Interest is compounding.`,
                    `${name} clipped a W. Filing it under "important."`,
                    `${name} did the thing. The thing is winning.`,
                    `${name} took the W. Pretending it was easy.`,
                    `${name} won and now walks a little taller.`,
                    `${name} scored a win. Ticker tape parade cancelled for budget reasons.`,
                    `${name} came, saw, and won ONE. Progress!`,
                    `${name} punched a W ticket. Destination: leaderboard.`,
                    `${name} secured a win. The clipboard is impressed.`,
                    `${name} is 1 for 1. Statistically perfect.`,
                    `${name} won. Solid start. Continue.`,
                    `${name} bagged a W. Feel free to celebrate quietly.`,
                    `${name} added one to the win column. Column growing.`,
                    `${name} tapped in a win. Precision play.`,
                    `${name} snagged a W. Warm-up complete.`,
                    `${name} squeezed out a win. Toothpaste-tube style.`,
                    `${name} clinched it. It: the match.`,
                    `${name} pulled through. Rewarded with dopamine.`,
                    `${name} rolled the ball and got a W. Physics approves.`,
                    `${name} outlasted, outplayed, out-won.`,
                    `${name} took the W and is being modest about it. So modest.`,
                    `${name} unlocked achievement: "did not lose this one."`,
                    `${name} got the dub. That's the technical term.`,
                    `${name} logged one W. Log looking prettier.`,
                    `${name} won the match. Confetti generator idling.`,
                ];
            }
        } else if (result.losses > 0 && result.wins === 0) {
            if (streak <= -8) {
                lines = [
                    `${name} is building character. So much character.`,
                    `${name} has requested a tactical blanket and no follow-up questions.`,
                    `${name} insists this is an extremely long training montage.`,
                    `${name} is ${Math.abs(streak)} losses deep. Suggestion: mercy rule.`,
                    `${name} is on a losing streak so long it qualifies for benefits.`,
                    `${name} has reached the "learning experience" boss level.`,
                    `${name} has entered rock bottom's basement.`,
                    `${name} is speed-running character development.`,
                    `${name} is not losing, they are gathering data. Lots of data.`,
                    `${name} has volunteered as the control group.`,
                    `${name} is currently the "before" photo in the tutorial.`,
                    `${name} is negative-vibing with impressive consistency.`,
                    `${name} is 0 for ${Math.abs(streak)}. Perfectly imperfect.`,
                    `${name} has ordered a helmet with extra character-building padding.`,
                    `${name} is starring in "How Not To." Rave reviews from opponents.`,
                    `${name} has entered the trenches. Snacks and morale welcome.`,
                    `${name} is banking losses like they'll pay dividends. They won't.`,
                    `${name} is spelunking the L-caves. Deep.`,
                    `${name} is currently a cautionary tale. A verbose one.`,
                    `${name} has become one with the L. The L accepts them.`,
                    `${name} is on the wrong side of the highlight reel. Repeatedly.`,
                    `${name} is stubbornly loyal to losing.`,
                    `${name} is ${Math.abs(streak)} losses in and philosophically at peace with it.`,
                    `${name} is starring in an art film called "The Fall."`,
                    `${name} is not tilting. They fell over hours ago.`,
                    `${name} has embraced the void. The void has embraced back.`,
                    `${name} is undefeated at losing.`,
                    `${name} has qualified for a losing-streak achievement. Congrats?`,
                    `${name} is ${Math.abs(streak)} games into what appears to be a series.`,
                    `${name} is being sponsored by regret.`,
                    `${name} has become one with the concept of "trying again."`,
                    `${name} is composing an autobiography titled "The L-Files."`,
                ];
            } else if (streak <= -3) {
                lines = [
                    `${name} is Frosty. Warm-up laps and snacks prescribed.`,
                    `${name} filed a formal complaint against matchmaking.`,
                    `${name} needs encouragement, premium fuel, and perhaps a tiny scarf.`,
                    `${name} is chilly. Emotionally.`,
                    `${name} is going through it. "It" being three straight losses.`,
                    `${name} is cold. Consider hot cocoa.`,
                    `${name} has entered a Frosty Winter arc.`,
                    `${name} is workshopping their comeback speech.`,
                    `${name} needs a hug and possibly a new server region.`,
                    `${name} is frosted. Not iced. Frosted.`,
                    `${name} is on a slippery streak. Send salt.`,
                    `${name} has been demanding a manager. Wal-Mart tone.`,
                    `${name} is in a slump. A cozy, sad little slump.`,
                    `${name} has requested a snow day.`,
                    `${name} is cold-brewing revenge.`,
                    `${name} is doing the "one more game to break the streak" thing. That's ${Math.abs(streak)} now.`,
                    `${name} is officially in "put down the controller" territory.`,
                    `${name} is negative-streaking. Send therapy dogs.`,
                    `${name} is trying to remember what a W feels like.`,
                    `${name} has entered thawing mode. Return in 20 minutes.`,
                    `${name} is doing the freeze dance. Involuntarily.`,
                    `${name} is the villain in their own hero's journey.`,
                    `${name} is stuck in the ice storm arc.`,
                    `${name} has ${Math.abs(streak)} losses and a bad attitude.`,
                    `${name} needs a heater and possibly a new mouse.`,
                    `${name} is frost-forming on the leaderboard.`,
                    `${name} is being iced out by fortune.`,
                    `${name} is cold-plunging into the L pool.`,
                    `${name} is starring in "Frozen 3: Rocket Boogaloo."`,
                    `${name} is chilly-billy. Snack up.`,
                    `${name} is muttering "one more" but it means one more L.`,
                    `${name} is going through a frosty patch. Ice cream may or may not help.`,
                ];
            } else if (result.losses > 1) {
                lines = [
                    `${name} survived ${result.losses} learning opportunities at supersonic speed.`,
                    `${name} lost ${result.losses}, but the wheels are still emotionally attached.`,
                    `${name} calls those ${result.losses} losses "extensive field research."`,
                    `${name} chalked up ${result.losses} Ls. Chalk supply low.`,
                    `${name} took ${result.losses} losses in stride. Stride is limping.`,
                    `${name} dropped ${result.losses} in a row. Pick-up truck idling.`,
                    `${name} logged ${result.losses} Ls into the shame ledger.`,
                    `${name} caught ${result.losses} losses. Return receipt requested.`,
                    `${name} took ${result.losses} on the chin. Chin holding up okay.`,
                    `${name} tacked on ${result.losses} Ls. Filed under "growth."`,
                    `${name} lost ${result.losses} matches. Number of feelings: too many.`,
                    `${name} dropped ${result.losses}. Pick 'em back up soon.`,
                    `${name} took ${result.losses} Ls to the face and kept going.`,
                    `${name} banked ${result.losses} losses. Bank disapproves.`,
                    `${name} incurred ${result.losses} L's. IRS unmoved.`,
                    `${name} has ${result.losses} fresh losses. Piping hot.`,
                    `${name} accepted ${result.losses} losses graciously. In private, less so.`,
                    `${name} experienced ${result.losses} setbacks. Big comeback probably loading.`,
                    `${name} collected ${result.losses} Ls. Displayed on the mantle. Reluctantly.`,
                    `${name} said "next one for sure" ${result.losses} times.`,
                    `${name} took ${result.losses} on the road. Road tired now.`,
                    `${name} put ${result.losses} losses in the character-building pile.`,
                    `${name} logged ${result.losses} lessons. Class dismissed.`,
                    `${name} filed ${result.losses} losses under "not today."`,
                    `${name} committed ${result.losses} losses to memory. Involuntarily.`,
                    `${name} donated ${result.losses} MMR to charity. Charity refuses to accept.`,
                    `${name} did ${result.losses} losses in one go. Efficient.`,
                    `${name} lost ${result.losses} matches and gained ${result.losses} grievances.`,
                    `${name} took ${result.losses} on the chin, ribs, and knees.`,
                    `${name} racked up ${result.losses} Ls. Rack tipping.`,
                    `${name} added ${result.losses} losses to the résumé. Under "experience."`,
                    `${name} sold their soul for MMR and lost ${result.losses} anyway.`,
                ];
            } else {
                lines = [
                    `${name} hit a learning opportunity at supersonic speed.`,
                    `${name} lost the match, not the plot. Probably.`,
                    `${name} says the controller was slippery.`,
                    `${name} is shaken, not stalled. Tiny comeback loading.`,
                    `${name} lost. Blames physics.`,
                    `${name} took a loss. Filed under "input lag." (It wasn't.)`,
                    `${name} lost one. Officially a rounding error.`,
                    `${name} dropped a match. Match landed softly on ego.`,
                    `${name} took an L. L takes ${name}.`,
                    `${name} lost. Cosmic balance restored.`,
                    `${name} took a loss. Sportsmanship: acceptable.`,
                    `${name} lost a close one. "Close" in a philosophical sense.`,
                    `${name} L-boarded a match. Skate away with pride.`,
                    `${name} has one L. One is a small number.`,
                    `${name} says "warm-up match." It wasn't.`,
                    `${name} took an L. Happens to the best of tires.`,
                    `${name} lost. Rest of the world unaffected.`,
                    `${name} dropped a match. Bendable, not broken.`,
                    `${name} took a loss. Insists it's teaching them.`,
                    `${name} L'd out. Bouncing back in T-minus one match.`,
                    `${name} lost. Feels like flat-tire weather.`,
                    `${name} is 0-1 and grumpy.`,
                    `${name} tanked a match. Tank functional. Ego bruised.`,
                    `${name} took an L. Please clap gently anyway.`,
                    `${name} skidded off a match. Traction control disagrees.`,
                    `${name} lost one. It's just recon for the next one.`,
                    `${name} took the L on principle.`,
                    `${name} dropped a match. Momentum: paused.`,
                    `${name} L'd. The scoreboard sighs.`,
                    `${name} lost the match. Blames alignment.`,
                    `${name} caught a loss. Please throw it back.`,
                    `${name} took an L. Will pretend to learn from it.`,
                ];
            }
        } else {
            lines = [
                `${name} processed ${result.wins}W/${result.losses}L and now requires a tiny spreadsheet.`,
                `${name} had a complicated session. Telemetry just sighed.`,
                `${name} experienced both victory and character development.`,
                `${name} went ${result.wins}-${result.losses}. Numerically confused.`,
                `${name} split the difference: ${result.wins}W / ${result.losses}L.`,
                `${name} had a bipartisan session.`,
                `${name} banked wins AND losses. Equal opportunity garage.`,
                `${name} went ${result.wins}-${result.losses}. Vibes: mixed salad.`,
                `${name} had a "some you win, some you lose, mostly gray" session.`,
                `${name} logged ${result.wins}W/${result.losses}L. Break-even energy.`,
                `${name} had a moderate day. Moderate is a word we chose.`,
                `${name} had a session with variety. Variety pack.`,
                `${name} ran a ${result.wins}-${result.losses} session. Statistically valid, emotionally not.`,
                `${name} had every kind of match today.`,
                `${name} went ${result.wins}W ${result.losses}L. Officially "trying."`,
                `${name} had wins. Also losses. It's a whole thing.`,
                `${name} had a mixed bag session. Bag contents varied.`,
                `${name} took ${result.wins} wins and gave back ${result.losses}. Balanced diet.`,
                `${name} experienced a session. That's all we can say.`,
                `${name} finished ${result.wins}-${result.losses}. Filed under "gray area."`,
                `${name} had a whiplash session. Sports psychologist on standby.`,
                `${name} was giving them AND taking them. Democracy in action.`,
                `${name} had a "some wins, some losses" arc. Peak sitcom.`,
                `${name} rolled ${result.wins}W ${result.losses}L. Dice uncooperative.`,
                `${name} went ${result.wins}-${result.losses}. Emotionally uncommitted.`,
                `${name} had a good-cop bad-cop session with themselves.`,
                `${name} logged ${result.wins} wins, ${result.losses} losses, and one existential crisis.`,
                `${name} had a session with dynamic range.`,
                `${name} tried both directions today.`,
                `${name} clocked ${result.wins} up, ${result.losses} down. Elevator vibes.`,
                `${name} finished with ${result.wins}W and ${result.losses}L. Committee split.`,
                `${name} had a "yes, and also no" kind of session.`,
            ];
        }
        }

        setBuddyStatus(pickBuddyLine(lines, buddyState.matchesDriven + Math.abs(streak) + result.matches));
    }

    function petBuddy() {
        ensureBuddy();
        const now = Date.now();
        if (now - (buddyState.lastPetAt || 0) < BUDDY_PET_COOLDOWN_MS) {
            const mins = Math.ceil((BUDDY_PET_COOLDOWN_MS - (now - buddyState.lastPetAt)) / 60000);
            showToast(`${buddyDisplayName()} was just petted — try again in ${mins}m`);
            return false;
        }
        buddyState.lastPetAt = now;
        const name = buddyDisplayName();
        setBuddyStatus(pickBuddyLine(
            buddyStatusLines("pet", { name }) || [
                `${name} was just petted. Horsepower increased by emotionally significant amounts.`,
                `${name} received head pats and is now legally unstoppable.`,
                `${name} says "again." The cooldown says "absolutely not."`,
                `${name} has been petted and is pretending not to love it.`,
            ],
            buddyState.matchesDriven + Math.floor(now / BUDDY_PET_COOLDOWN_MS)
        ));
        return true;
    }

    function stopBuddyRefreshTimer() {
        if (!buddyRefreshTimer) return;
        clearInterval(buddyRefreshTimer);
        buddyRefreshTimer = null;
    }

    function startBuddyRefreshTimer() {
        if (buddyRefreshTimer) return;
        buddyRefreshTimer = setInterval(() => {
            const view = document.getElementById("rgBuddyView");
            if (!view || view.style.display === "none") {
                stopBuddyRefreshTimer();
                return;
            }
            // minimized HUD keeps buddy view display=block. offsetParent catches that.
            if (!view.offsetParent) return;
            // don't yank a focused control, next tick catches up
            if (!view.contains(document.activeElement)) renderBuddyView();
        }, 60 * 1000);
    }

    function renderBuddyViewAndRestoreFocus(focusId) {
        renderBuddyView();
        if (!focusId) return;
        requestAnimationFrame(() => {
            const next = document.getElementById(focusId);
            if (next) next.focus({ preventScroll: true });
        });
    }

    // ---- Buddy view render ----
    // full innerHTML rebuild. escape anything user-controlled (name).
    function renderBuddyView() {
        const view = document.getElementById("rgBuddyView");
        if (!view) return;
        ensureBuddy();
        const stage = buddyStage();
        const mood = buddyMood();
        reportBuddyMoodTransition(mood);
        const energy = buddyEnergy();
        const req = buddyNextStageRequirement();

        // day-one edge case
        const ageDays = Math.floor((Date.now() - buddyState.birthAt) / (24 * 3600 * 1000));
        const ageStr = ageDays === 0 ? "born today" : `${ageDays} day${ageDays === 1 ? "" : "s"}`;

        const stars = Array.from({ length: BUDDY_STAGES.length }, (_, i) =>
            i < stage.level ? "★" : "☆").join(" ");

        const bestRankStr = stage.bestRank === Infinity
            ? "—"
            : `#${stage.bestRank}`;

        let nextLine;
        if (!req) {
            nextLine = `<span style="color:#ffd700;">Max stage reached 🏆</span>`;
        } else if (req.matches > 0 && req.rankTop != null) {
            nextLine = `${req.matches} more matches <b>AND</b> top ${req.rankTop} in any mode`;
        } else if (req.matches > 0) {
            nextLine = `${req.matches} more matches`;
        } else if (req.rankTop != null) {
            nextLine = `Reach top ${req.rankTop} in any mode`;
        } else {
            nextLine = `Ready to evolve!`;
        }

        // 10-slot energy bar. red/amber/green
        const filled = Math.round(energy / 10);
        const barColor = energy < 20 ? "#ff6b6b" : (energy < 50 ? "#ffbb33" : "#00ff66");
        const bar = `<span style="color:${barColor};font-family:monospace;letter-spacing:-1px;">${"█".repeat(filled)}${"░".repeat(10 - filled)}</span>`;

        // stage 4/5 get a radial ring behind
        const skin = currentBuddySkin();
        ensureBuddySpriteStyles();
        ensureBuddySheetLoaded(skin.id);
        const moodSprite = BUDDY_MOOD_SPRITE[mood.key] || "idle";
        const useSpriteFallback = buddySheetLoadStateFor(skin.id) !== "ready";
        const sheetCssUrl = buddySheetCssUrl(skin.sheetUrl);
        let spriteWrap = "";
        if (stage.level >= 5) {
            spriteWrap = "background:radial-gradient(circle, #ffd70044 0%, transparent 70%);padding:8px;border-radius:50%;";
        } else if (stage.level >= 4) {
            spriteWrap = "background:radial-gradient(circle, #00bfff33 0%, transparent 70%);padding:6px;border-radius:50%;";
        }

        const isNewbie = buddyState.matchesDriven === 0;
        const displayName = buddyDisplayName();
        const skinOptions = BUDDY_SKIN_ORDER.map(id => {
            const s = BUDDY_SKINS[id];
            const sel = s.id === skin.id ? " selected" : "";
            return `<option value="${s.id}"${sel}>${escapeHtml(s.label)}</option>`;
        }).join("");

        view.innerHTML = `
            <div style="text-align:center;padding:8px 4px 12px;">
                <div style="display:inline-block;${spriteWrap}"><div id="rgBuddySprite" class="rg-buddy-sprite stage-${stage.level} mood-${moodSprite}${useSpriteFallback ? " is-fallback" : ""}" style="--rb-sheet-url:${sheetCssUrl};" role="img" aria-label="${escapeHtml(stage.name)}">${useSpriteFallback ? stage.icon : ""}</div></div>
                <div style="margin-top:6px;font-size:14px;font-weight:bold;color:#00bfff;">${escapeHtml(displayName)}</div>
                <div style="font-size:11px;opacity:0.85;">${escapeHtml(stage.name)} · Lv ${stage.level}</div>
                <div style="margin-top:2px;font-size:13px;color:#ffd700;letter-spacing:2px;">${stars}</div>
            </div>

            <div style="font-size:11px;background:#00bfff11;border-radius:6px;padding:6px 8px;margin-bottom:8px;">
                <label for="rgBuddySkin" style="opacity:0.7;">Buddy style</label>
                <select id="rgBuddySkin" class="rg-buddy-skin-select" aria-label="Buddy style">${skinOptions}</select>
            </div>

            <div style="font-size:11px;background:#00bfff11;border-radius:6px;padding:6px 8px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;">
                    <span style="color:${mood.color};font-weight:bold;">${mood.label}</span>
                    <span style="opacity:0.7;">${streakData?.streak ? Math.abs(streakData.streak) + (streakData.streak > 0 ? "W" : "L") + " streak" : ""}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
                    <span style="opacity:0.7;">Energy</span>
                    <span>${bar} ${energy}%</span>
                </div>
            </div>

            ${buddyState.lastStatus ? `
                <div style="font-size:11px;line-height:1.4;background:#ffd7000d;border-left:2px solid #ffd70088;border-radius:4px;padding:6px 8px;margin-bottom:8px;">
                    <span aria-hidden="true">💬</span> ${escapeHtml(buddyState.lastStatus)}
                </div>
            ` : ""}

            ${isNewbie ? `
                <div style="font-size:11px;opacity:0.85;background:#00bfff11;border-radius:6px;padding:8px;margin-bottom:8px;">
                    Just hatched. Play a match to give ${escapeHtml(displayName)} their first
                    laps.
                </div>
            ` : `
                <div style="font-size:11px;line-height:1.6;">
                    <div style="display:flex;justify-content:space-between;"><span style="opacity:0.7;">Age</span><span>${ageStr}</span></div>
                    <div style="display:flex;justify-content:space-between;"><span style="opacity:0.7;">Matches driven</span><span>${buddyState.matchesDriven}</span></div>
                    <div style="display:flex;justify-content:space-between;"><span style="opacity:0.7;">Best rank</span><span>${bestRankStr}</span></div>
                    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;"><span style="opacity:0.7;">Next stage</span><span style="text-align:right;">${nextLine}</span></div>
                </div>
            `}

            <div style="display:flex;gap:4px;margin-top:10px;">
                <button id="rgBuddyPet" class="rgBtn" style="flex:1;">🫳 Pet</button>
                <button id="rgBuddyRename" class="rgBtn" style="flex:1;">✏️ Name</button>
                <button id="rgBuddyEquip" class="rgBtn" style="flex:1;">${buddyState.equipped ? "◉ Equipped" : "◯ Equip"}</button>
            </div>
        `;

        // bounce anim, cooldown-gated
        document.getElementById("rgBuddyPet").onclick = e => {
            const restoreFocus = e.detail === 0 ? "rgBuddyPet" : null;
            dbg("Buddy pet clicked");
            if (!petBuddy()) { dbg("Buddy pet skipped (cooldown)"); return; }
            const sprite = document.getElementById("rgBuddySprite");
            const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
            if (sprite && !reduceMotion) {
                sprite.style.transition = "transform 0.15s ease";
                sprite.style.transform = "scale(1.25)";
                setTimeout(() => { sprite.style.transform = ""; }, 150);
            }
            // repaint, energy just jumped
            setTimeout(() => renderBuddyViewAndRestoreFocus(restoreFocus), reduceMotion ? 0 : 320);
        };

        // empty name -> "Unnamed"
        document.getElementById("rgBuddyRename").onclick = async e => {
            const restoreFocus = e.detail === 0 ? "rgBuddyRename" : null;
            dbg("Buddy rename opened");
            let newName;
            try {
                newName = await showDialog({
                    message: "Name your Buddy",
                    withInput: true,
                    inputPlaceholder: buddyDisplayName(),
                    okLabel: "Save",
                    cancelLabel: "Cancel",
                });
            } catch (err) {
                pushError(err, "buddyRenameDialog");
                return;
            }
            if (newName === null) {
                dbg("Buddy rename cancelled");
                if (restoreFocus) requestAnimationFrame(() => {
                    document.getElementById(restoreFocus)?.focus({ preventScroll: true });
                });
                return;
            }
            const clean = String(newName).slice(0, 20).trim();
            dbg(`Buddy rename saved: rawLen=${String(newName).length} cleanLen=${clean.length}`);
            buddyState.name = clean;
            saveBuddyState();
            renderBuddyViewAndRestoreFocus(restoreFocus);
        };

        // toggles the mini flair on the stats view
        document.getElementById("rgBuddyEquip").onclick = e => {
            const restoreFocus = e.detail === 0 ? "rgBuddyEquip" : null;
            buddyState.equipped = !buddyState.equipped;
            dbg(`Buddy equip toggled -> ${buddyState.equipped}`);
            saveBuddyState();
            // repaint so the flair reflects the toggle
            if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
            else renderBuddyView();
            if (restoreFocus) requestAnimationFrame(() => {
                document.getElementById(restoreFocus)?.focus({ preventScroll: true });
            });
        };

        document.getElementById("rgBuddySkin").onchange = e => {
            const next = getBuddySkin(e.target.value);
            if (next.id === buddyState.skinId) return;
            dbg(`Buddy skin changed: ${buddyState.skinId} -> ${next.id}`);
            buddyState.skinId = next.id;
            saveBuddyState();
            ensureBuddySheetLoaded(next.id);
            refreshBuddyButtonIcon();
            const switchLines = buddyStatusLines("skinSelect", {
                name: buddyDisplayName(),
                label: next.label,
            }) || [
                `${buddyDisplayName()} switched to ${next.label}. Looking sharp.`,
                `${buddyDisplayName()} tried on ${next.label}. The vibe shifted.`,
                `${buddyDisplayName()} is now rocking ${next.label}.`,
            ];
            setBuddyStatus(pickBuddyLine(switchLines, Date.now()), false);
            if (lastKnownPlayerData && buddyState.equipped) updateHUD(lastKnownPlayerData);
            renderBuddyViewAndRestoreFocus("rgBuddySkin");
        };
    }

    // mini buddy icon next to streak badge. local only.
    function buddyMiniVisualHtml(stage) {
        const skin = currentBuddySkin();
        return buddySheetLoadStateFor(skin.id) === "ready"
            ? `<span class="rg-buddy-mini" style="--rb-mini-stage:${stage.level - 1};--rb-sheet-url:${buddySheetCssUrl(skin.sheetUrl)};" aria-hidden="true"></span>`
            : stage.icon;
    }

    // buddy icon for the toolbar button. uses the current skin. emoji fallback if the sheet isn't loaded yet.
    function buddyButtonIconHtml() {
        try {
            ensureBuddy();
            const stage = buddyStage();
            const skin = currentBuddySkin();
            if (buddySheetLoadStateFor(skin.id) === "ready") {
                return `<span class="rg-buddy-btn-icon" style="--rb-bi-stage:${stage.level - 1};--rb-sheet-url:${buddySheetCssUrl(skin.sheetUrl)};" aria-hidden="true"></span>`;
            }
            return stage.icon;
        } catch (e) {
            return "🚗";
        }
    }
    function refreshBuddyButtonIcon() {
        const btn = document.getElementById("rgBuddyBtn");
        if (!btn) return;
        btn.innerHTML = buddyButtonIconHtml();
    }

    function buddyEquippedFlairHtml() {
        try {
            ensureBuddy();
            if (!buddyState.equipped) return "";
            const stage = buddyStage();
            const skin = currentBuddySkin();
            ensureBuddySpriteStyles();
            ensureBuddySheetLoaded(skin.id);
            return ` <span id="rgBuddyEquippedFlair" class="rgHasTip rgNoUnderline" data-tip="${escapeHtml(buddyDisplayName())} · ${escapeHtml(stage.name)}" aria-label="${escapeHtml(buddyDisplayName())} · ${escapeHtml(stage.name)}" style="font-size:14px;vertical-align:middle;">${buddyMiniVisualHtml(stage)}</span>`;
        } catch (e) {
            dbg("buddyEquippedFlairHtml threw: " + (e && e.message ? e.message : e));
            return "";
        }
    }

    // ---------- Ranks ----------

    const cachedRanks = new Map();      // playlist -> rank
    const cachedMmrToNext = new Map();  // playlist -> mmr gap to next rank (null if #1)

    function rankBadge(playlist) {
        const r = cachedRanks.get(playlist);
        if (!r) return "";

        // gold top 3, purple top 10, cyan top 25, gray beyond
        let color;
        if (r <= 3) color = "#ffd700";
        else if (r <= 10) color = "#c77dff";
        else if (r <= 25) color = "#00d4ff";
        else color = "#9aa5ad";

        const gap = cachedMmrToNext.get(playlist);
        let tip;
        if (r === 1) tip = "You're #1! 👑";
        else if (typeof gap === "number") tip = `+${gap} MMR to reach #${r - 1}`;
        else tip = `Rank #${r}`;

        return ` <span class="rgHasTip" data-tip="${tip}" style="color:${color};font-size:10px;font-weight:bold;">#${r}</span>`;
    }

    // ---------- Crown system ----------
    // KING title while holding any #1. banners on coronation + dethrone.

    const prevRanks = new Map(); // playlist -> last known rank

    // ---------- Momentum system ----------
    // net MMR gained/lost this session. tweaks title + glow speed/intensity only,
    // never the user's chosen colors.

    const MOMENTUM_TIERS = {
        flowState: 250,
        onFire:    150,
        heatingUp: 75,
        cold:      -20,
        shutEye:   -75,
    };

    const SHUT_EYE_MESSAGES = [
        "😴 Maybe it's time for some shut-eye?",
        "😴 The ball will still be here tomorrow...",
        "🛌 Consider: a strategic nap.",
        "☕ Touch grass? Or at least grab a coffee.",
        "😅 Rough one. Shake it off, champ.",
    ];
    let shutEyeMessage = SHUT_EYE_MESSAGES[Math.floor(Math.random() * SHUT_EYE_MESSAGES.length)];

    // read by applyGlowSettings
    let momentumGlow = { speedMult: 1, intensity: 1 };
    let currentMomentumState = "neutral";

    function netSessionMMR() {
        if (!sessionStart || !lastKnownPlayerData) return 0;
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        let net = 0;
        for (const m of modes) {
            const cur = lastKnownPlayerData.ModesGlicko?.[m]?.displayRating;
            const start = sessionStart[m];
            if (typeof cur === "number" && typeof start === "number") net += cur - start;
        }
        return net;
    }

    function computeMomentumState(net) {
        if (net <= MOMENTUM_TIERS.shutEye) return "shutEye";
        if (net <= MOMENTUM_TIERS.cold) return "cold";
        if (net >= MOMENTUM_TIERS.flowState) return "flowState";
        if (net >= MOMENTUM_TIERS.onFire) return "onFire";
        if (net >= MOMENTUM_TIERS.heatingUp) return "heatingUp";
        return "neutral";
    }

    // priority: crown > clash lead > momentum > default
    function resolveTitle() {
        const holdingAnyFirst = [...cachedRanks.values()].some(r => r === 1);
        if (holdingAnyFirst) return { text: "👑 Rocket Goal KING", color: "#ffd700" };
        if (isMyClanLeadingClash()) return { text: "👑 Leading the Clash", color: "#ffd700" };

        switch (currentMomentumState) {
            case "shutEye":   return { text: shutEyeMessage, color: "#9aa5ad" };
            case "cold":      return { text: "❄️ Ice Cold", color: "#7ec8ff" };
            case "flowState": return { text: "🏄 Flow State", color: "#b14bff" };
            case "onFire":    return { text: "🔥 ON FIRE", color: "#ff5b1f" };
            case "heatingUp": return { text: "🔥 Heating Up", color: "#ff9a3c" };
            default:
                if (settings.ogTitle) return { text: "🚀 Rocket Goal HUD", color: "#00bfff" };
                return { text: atlasIconHtml() + "ATLAS", color: "#00bfff", html: true };
        }
    }

    function applyTitle() {
        const titleEl = document.getElementById("rgTitle");
        if (!titleEl) return;
        const { text, color, html } = resolveTitle();
        // html:true only for the ATLAS default (own img)
        if (html) titleEl.innerHTML = text;
        else titleEl.textContent = text;
        titleEl.style.color = color;
    }

    function updateMomentum(forceState = null) {
        const newState = forceState ?? computeMomentumState(netSessionMMR());
        const changed = newState !== currentMomentumState;
        currentMomentumState = newState;

        switch (newState) {
            case "flowState": momentumGlow = { speedMult: 3.0, intensity: 1.8 }; break;
            case "onFire":    momentumGlow = { speedMult: 2.2, intensity: 1.5 }; break;
            case "heatingUp": momentumGlow = { speedMult: 1.5, intensity: 1.2 }; break;
            case "cold":      momentumGlow = { speedMult: 0.5, intensity: 0.7 }; break;
            case "shutEye":   momentumGlow = { speedMult: 0.35, intensity: 0.55 }; break;
            default:          momentumGlow = { speedMult: 1, intensity: 1 };
        }

        applyGlowSettings();
        applyTitle();

        if (changed) {
            if (newState === "flowState") showBanner("🏄 FLOW STATE ACHIEVED!", "#b14bff");
            else if (newState === "onFire") showBanner("🔥 YOU'RE ON FIRE!", "#ff5b1f");
            else if (newState === "shutEye") {
                shutEyeMessage = SHUT_EYE_MESSAGES[Math.floor(Math.random() * SHUT_EYE_MESSAGES.length)];
                showBanner(shutEyeMessage, "#9aa5ad");
            }
        }
    }

    let bannerTimeout = null;

    function showBanner(text, color) {
        createHUD();
        let banner = document.getElementById("rgBanner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "rgBanner";
            banner.style.cssText = `
                position:absolute;
                top:-38px;
                left:0;
                right:0;
                text-align:center;
                font-weight:bold;
                font-size:13px;
                padding:6px 8px;
                border-radius:8px;
                background:rgba(10,14,18,0.95);
                border:1px solid;
                opacity:0;
                transition:opacity 0.4s ease, transform 0.4s ease;
                transform:translateY(6px);
                pointer-events:none;
            `;
            hud.appendChild(banner);
        }

        banner.textContent = text;
        banner.style.color = color;
        banner.style.borderColor = color;

        requestAnimationFrame(() => {
            banner.style.opacity = "1";
            banner.style.transform = "translateY(0)";
        });

        clearTimeout(bannerTimeout);
        bannerTimeout = setTimeout(() => {
            banner.style.opacity = "0";
            banner.style.transform = "translateY(6px)";
        }, 3500);
    }

    function checkRankTransitions() {
        for (const [playlist, rank] of cachedRanks) {
            const prev = prevRanks.get(playlist);

            // need a prior non-#1 or this fires on session start
            if (rank === 1 && typeof prev === "number" && prev !== 1) {
                showBanner(`👑 NEW #1 IN ${playlist.toUpperCase()}!`, "#ffd700");
            }

            if (prev === 1 && rank !== 1) {
                showBanner(`⚔️ Dethroned in ${playlist.toUpperCase()}!`, "#ff6b6b");
            }

            prevRanks.set(playlist, rank);
        }

        applyTitle();
    }

    // ---------- HUD content ----------

    // renders only when event active + in a clan with baseline. no extra reads.
    // returns "" when nothing to show so callers can splice unconditionally.
    function clashMiniBarHtml() {
        try {
            if (typeof eventPhase !== "function" || eventPhase() !== "active") return "";
            if (!myClan) return "";
            const uid = myUserId();
            const contrib = myEventContribution(myClan, uid);
            const clanScore = computeClanEventScore(myClan);
            const standings = eventStandings();
            const rank = standings.findIndex(c => c.id === myClan.id) + 1;
            if (!rank) return ""; // baseline not landed yet
            const cSign = (contrib ?? 0) >= 0 ? "+" : "";
            const cColor = (contrib ?? 0) >= 0 ? "#00ff66" : "#ff6b6b";
            const clanSign = clanScore >= 0 ? "+" : "";
            const clanColor = clanScore >= 0 ? "#00ff66" : "#ff6b6b";
            const rankColor = rank === 1 ? "#ffd700" : (rank <= 3 ? "#00bfff" : "#ffffff");
            return `
                <hr style="border:none;border-top:1px solid #00bfff44;margin:8px 0 6px;">
                <div style="font-size:11px;line-height:1.4;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span><b>👑 Clash</b> <span style="color:${rankColor};">#${rank}/${standings.length}</span></span>
                        <span style="opacity:.7;">${escapeHtml(String(eventConfig?.name || ""))}</span>
                    </div>
                    <div style="opacity:.9;margin-top:2px;">
                        You <span style="color:${cColor};">${cSign}${typeof contrib === "number" ? contrib : "—"}</span>
                        <span style="opacity:.4;">•</span>
                        Clan <span style="color:${clanColor};">${clanSign}${clanScore}</span>
                    </div>
                </div>
            `;
        } catch (e) {
            // decorative, never break render for this
            dbg("clashMiniBarHtml threw: " + (e && e.message ? e.message : e));
            return "";
        }
    }

    function updateHUD(data) {
        createHUD();
        lastKnownPlayerData = data;
        captureSessionStart(data);
        const buddyMatchResult = updateStreak(data);
        updateMomentum();
        if (buddyMatchResult) {
            try { reportBuddyMatchStatus(buddyMatchResult); } catch (e) { dbg("reportBuddyMatchStatus threw: " + (e && e.message ? e.message : e)); }
        }
        // buddyMood reads streakData, tick buddy after streak update
        try { tickBuddyFromData(data); } catch (e) { dbg("tickBuddyFromData threw: " + (e && e.message ? e.message : e)); }
        // sync buddy tab if open
        const bv = document.getElementById("rgBuddyView");
        if (bv && bv.style.display !== "none") renderBuddyView();
        // keep the toolbar button in sync with the buddy's current stage
        refreshBuddyButtonIcon();

        const ratingVal = mode => data.ModesGlicko?.[mode]?.displayRating;
        const rating = mode => {
            const v = ratingVal(mode);
            return typeof v === "number" ? v : "—";
        };

        const wr = mode => {
            const d = data.ModesData?.[mode];
            if (!d || !d.matchesPlayed) return "0.0";
            return (100 * d.wins / d.matchesPlayed).toFixed(1);
        };

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        document.getElementById("rgContent").innerHTML = `
            <div style="display:flex;gap:12px;">
                <div style="white-space:nowrap;">
                    <b>🏆 Ratings</b><br>
                    3v3: <span style="color:#00ff66">${rating("Competitive3v3")}</span>${rankBadge("3v3")}${deltaBadge("Competitive3v3", ratingVal("Competitive3v3"))}<br>
                    2v2: <span style="color:#00ff66">${rating("Competitive2v2")}</span>${rankBadge("2v2")}${deltaBadge("Competitive2v2", ratingVal("Competitive2v2"))}<br>
                    1v1: <span style="color:#00ff66">${rating("Competitive1v1")}</span>${rankBadge("1v1")}${deltaBadge("Competitive1v1", ratingVal("Competitive1v1"))}<br>
                    Casual: <span style="color:#00ff66">${rating("Casual")}</span>${deltaBadge("Casual", ratingVal("Casual"))}
                </div>
                <div style="width:1px;background:#00bfff88;flex-shrink:0;"></div>
                <div style="white-space:nowrap;">
                    <b>📊 Win Rates</b><br>
                    3v3 <span style="color:#00ff66">${wr("Competitive3v3")}%</span><br>
                    2v2 <span style="color:#00ff66">${wr("Competitive2v2")}%</span><br>
                    1v1 <span style="color:#00ff66">${wr("Competitive1v1")}%</span><br>
                    Casual <span style="color:#00ff66">${wr("Casual")}%</span>
                </div>
            </div>

            <hr style="border:none;border-top:1px solid #00bfff88;margin:10px 0;">

            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    Wins: <span style="color:#00ff66">${totalWins}</span><br>
                    Matches Played: <span style="color:#00ff66">${totalMatches}</span>
                </div>
                <div style="font-size:15px;">${streakBadge()}${buddyEquippedFlairHtml()}</div>
            </div>
            ${clashMiniBarHtml()}
        `;
    }

    let lastProcessedText = null;
    let lastProcessedKey = null;

    function tryParseAndUpdate(text) {
        // fast path, identical string
        if (text === lastProcessedText) return;

        try {
            const data = JSON.parse(text);
            if (!(data && data.ModesGlicko)) return;

            // fetch + console hooks can emit byte-different strings for the same
            // event. build a stable key. set BEFORE submit fires or the paths race.
            const key = data.Id + "|"
                + (data.ModesGlicko?.Competitive3v3?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Competitive2v2?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Competitive1v1?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Casual?.displayRating ?? "") + "|"
                + (data.ModesData?.Competitive3v3?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Competitive2v2?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Competitive1v1?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Casual?.matchesPlayed ?? "");
            if (key === lastProcessedKey) return;

            lastProcessedText = text;
            lastProcessedKey = key;
            _lastValidRatingsAt = performance.now(); // watchdog signal
            updateHUD(data);
            submitToLeaderboard(data);
        } catch (e) {
            // 13.5 swallowed this silently
            dbg("tryParseAndUpdate threw: " + (e && e.message ? e.message : e));
        }
    }

    // ---------- Leaderboard submission ----------

    // public client config, not a secret. null to disable submissions.
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
        authDomain: "rgleaderboard.firebaseapp.com",
        projectId: "rgleaderboard",
        storageBucket: "rgleaderboard.firebasestorage.app",
        messagingSenderId: "247848634543",
        appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
        measurementId: "G-JW3Q972P9T",
    };

    // full dump. site reads the trimmed "leaderboard" collection that
    // syncToRealLeaderboard writes to.
    const LEADERBOARD_COLLECTION = "script_submissions";

    let firestoreReady = null;

    async function initFirebase() {
        if (!FIREBASE_CONFIG) return null;
        if (firestoreReady) return firestoreReady;

        try {
            const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
            const { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc, getCountFromServer, orderBy, limit, deleteDoc, serverTimestamp, onSnapshot } =
                await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

            const app = initializeApp(FIREBASE_CONFIG);
            const db = getFirestore(app);

            firestoreReady = { db, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc, getCountFromServer, orderBy, limit, deleteDoc, serverTimestamp, onSnapshot };
            return firestoreReady;
        } catch (e) {
            console.error("[RG HUD] Firebase init failed:", e);
            showError("Firebase failed to load");
            return null;
        }
    }

    // ---------- Force-update gate ----------
    // admin/blacklist has { minVersion }. rules reject writes below anyway.
    // check once per session, skip submits if outdated. display stays on.

    let updateRequiredChecked = false;
    let updateRequired = false;

    async function isUpdateRequired(fb) {
        if (updateRequiredChecked) return updateRequired;
        try {
            // one read covers version + blacklist
            const snap = await fb.getDoc(fb.doc(fb.db, "admin", "blacklist"));
            if (snap.exists()) {
                const minV = snap.data().minVersion;
                if (typeof minV === "number" && SCRIPT_VERSION_NUM < minV) {
                    updateRequired = true;
                    showError(`HUD v${SCRIPT_VERSION} is outdated -- update via Tampermonkey to resume leaderboard sync`);
                    showBanner("⬆️ HUD update required! Tampermonkey → Check for updates", "#ffcf5b");
                }
            }
        } catch (e) {
            // don't lock out on transient read error
        }
        updateRequiredChecked = true;
        return updateRequired;
    }

    // strips TMP tags (<#rrggbb>, <br>, etc.)
    function cleanName(name) {
        return (name ?? "")
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    // not exhaustive. \b avoids catching "classic" / "assassin".
    const PROFANITY_LIST = [
        // common curses
        "fuck", "fuk", "fvck", "fck", "shit", "sh1t", "shyt", "bitch", "b1tch",
        "cunt", "asshole", "ass hole", "dick", "d1ck", "cock", "pussy", "pu55y",
        "bastard", "damn", "piss", "twat", "wanker", "bollocks", "arse",
        // slurs (racial / ethnic)
        "nigger", "nigga", "n1gger", "n1gga", "chink", "spic", "wetback",
        "gook", "kike", "beaner", "coon", "paki",
        // slurs (homophobic / transphobic)
        "faggot", "fag", "f4g", "dyke", "tranny", "shemale",
        // slurs (ableist / other)
        "retard", "retarded", "r3tard", "spastic", "cripple",
        // sexual / degrading
        "whore", "slut", "hoe", "rape", "rapist", "molest", "pedo", "pedophile",
        // hate groups / extremist terms
        "nazi", "hitler", "kkk",
    ];
    const PROFANITY_REGEX = new RegExp(`\\b(${PROFANITY_LIST.join("|")})\\b`, "i");

    // uppercase letters only. enforced on input and submit.
    function sanitizeClanTag(raw) {
        return String(raw || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    }

        function containsProfanity(text) {
        return PROFANITY_REGEX.test(text);
    }

    // rejects any emoji / pictographic incl. flag sequences
    const EMOJI_REGEX = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[\u{1F1E6}-\u{1F1FF}\u{1F3F3}\u{1F3F4}\u{E0020}-\u{E007F}\u{200D}]/u;
    function containsEmoji(text) {
        return EMOJI_REGEX.test(text);
    }

    function hasPlayedAnything(data) {
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        return modes.some(m => (data.ModesData?.[m]?.matchesPlayed ?? 0) > 0);
    }

    // ---------- In-HUD name modal (replaces window.prompt) ----------

    let nameModalResolve = null;

    function showNameModal(title, defaultValue, isRealPrompt, resolve) {
        createHUD();
        const modal = document.getElementById("rgNameModal");
        const input = document.getElementById("rgNameInput");
        document.getElementById("rgNameTitle").textContent = title;
        document.getElementById("rgNameError").textContent = "";
        input.value = defaultValue;
        modal.style.display = "flex";
        nameModalResolve = isRealPrompt ? resolve : null;
        if (isRealPrompt) {
            setTimeout(() => input.focus(), 50);
            probeInput(input, "rgNameInput");
        }
    }

    function hideNameModal() {
        const modal = document.getElementById("rgNameModal");
        if (modal) modal.style.display = "none";
        nameModalResolve = null;
    }

    function hideNameModalSoon() {
        setTimeout(hideNameModal, 1600);
    }

    // Unity swallows printable keys in capture phase. intercept earlier
    // and stopImmediatePropagation while a HUD input is focused so the game
    // never sees the event.
    ["keydown", "keyup", "keypress"].forEach(type => {
        window.addEventListener(type, e => {
            const active = document.activeElement;
            const dialog = document.getElementById("rgDialog");
            const dialogOpen = dialog && dialog.style.display === "flex";
            if (dialogOpen) {
                e.stopImmediatePropagation();
                if (type === "keydown" && e.key === "Escape") {
                    e.preventDefault();
                    const btn = document.getElementById("rgDialogCancel");
                    if (btn && btn.style.display !== "none") btn.click();
                } else if (type === "keydown" && e.key === "Enter"
                    && (active?.id === "rgDialogInput" || active?.id === "rgDialogOk")) {
                    e.preventDefault();
                    document.getElementById("rgDialogOk")?.click();
                } else if (type === "keydown" && e.key === "Enter" && active?.id === "rgDialogCancel") {
                    e.preventDefault();
                    document.getElementById("rgDialogCancel")?.click();
                }
                return;
            }
            const inHud = active && hud && hud.contains(active)
                && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
                && active.type !== "checkbox" && active.type !== "range" && active.type !== "color";
            if (inHud) {
                e.stopImmediatePropagation();
                // Enter saves the name modal
                if (type === "keydown" && e.key === "Enter" && active.id === "rgNameInput") {
                    const saveBtn = document.getElementById("rgNameSave");
                    if (saveBtn && !saveBtn.disabled) saveBtn.click();
                }
            }
        }, true); // capture — must run before Unity's listener
    });

    // best-effort collision check. two simultaneous picks could both pass but
    // that's fine, catches every normal case.
    async function isNameTaken(fb, name, ownSourceUserId) {
        try {
            const q = fb.query(
                fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                fb.where("name", "==", name)
            );
            const snap = await fb.getDocs(q);
            // taken only if some entry belongs to another player
            return snap.docs.some(d => d.data().sourceUserId !== ownSourceUserId);
        } catch (e) {
            // don't block on check failure, let it through
            console.warn("[RG HUD] Name availability check failed:", e);
            return false;
        }
    }

    function askDisplayName(suggestion, isRename, fb, ownSourceUserId) {
        return new Promise(resolve => {
            const title = isRename
                ? "Enter your new leaderboard name:"
                : "Pick your leaderboard name to appear on the board:";
            showNameModal(title, suggestion, true, resolve);

            const input = document.getElementById("rgNameInput");
            const errEl = document.getElementById("rgNameError");
            const saveBtn = document.getElementById("rgNameSave");

            saveBtn.onclick = async () => {
                const entered = input.value.trim();
                if (entered.length === 0 || entered.length > 15) {
                    errEl.textContent = "Name must be 1-15 characters.";
                    return;
                }
                if (containsProfanity(entered)) {
                    errEl.textContent = "That name isn't allowed. Pick something else.";
                    return;
                }
                if (entered.toLowerCase() === "player") {
                    errEl.textContent = "\"Player\" is reserved. Pick a real name.";
                    return;
                }
                if (containsEmoji(entered)) {
                    errEl.textContent = "Names can't contain emojis.";
                    return;
                }

                // async availability check
                errEl.style.color = "#7ec8ff";
                errEl.textContent = "Checking availability...";
                saveBtn.disabled = true;
                const taken = fb ? await isNameTaken(fb, entered, ownSourceUserId) : false;
                saveBtn.disabled = false;
                errEl.style.color = "#ff6b6b";

                if (taken) {
                    errEl.textContent = "That name is already taken. Pick another.";
                    return;
                }

                errEl.textContent = "";
                hideNameModal();
                resolve(entered);
            };

            document.getElementById("rgNameCancel").onclick = () => {
                hideNameModal();
                resolve(null); // cancel -> skip this submission
            };

            // Enter-to-save is wired in the window capture listener above
        });
    }

    // ---------- Write-reduction caches ----------
    // read nothing twice per session, write nothing that hasn't changed.

    let firestoreWriteCount = 0;
    function logWrite(label) {
        firestoreWriteCount++;
        console.log(`[RG HUD] Firestore write #${firestoreWriteCount} (${label})`);
    }

    const cachedDisplayNames = new Map();  // player -> displayName
    const lastSyncSnapshot = new Map();    // player -> last payload JSON
    const knownDocIds = new Map();         // player+mode -> doc id

    const SYNC_COOLDOWN_MS = 20000;
    const lastSyncTime = new Map();

    let forceRenamePrompt = false;

    // serialize per-player so races can't double-prompt or double-write
    const submitLocks = new Map();

    async function submitToLeaderboard(data) {
        const lockKey = data.Id;
        const previous = submitLocks.get(lockKey) || Promise.resolve();
        const current = previous.then(() => submitToLeaderboardInner(data));
        submitLocks.set(lockKey, current);
        await current;
    }

    async function submitToLeaderboardInner(data) {
        if (!hasPlayedAnything(data)) return;

        const fb = await initFirebase();
        if (!fb) return;
        if (await isUpdateRequired(fb)) return;

        const docRef = fb.doc(fb.db, LEADERBOARD_COLLECTION, data.Id);

        // ask for display name once per player unless Rename forces it
        let existingDisplayName = cachedDisplayNames.get(data.Id) ?? null;

        if (!existingDisplayName || forceRenamePrompt) {
            try {
                const existing = await fb.getDoc(docRef);
                if (existing.exists() && existing.data().displayName) {
                    existingDisplayName = existing.data().displayName;
                }
            } catch (e) {
                // fall through and ask
            }
        }

        let displayName = (!forceRenamePrompt && existingDisplayName) ? existingDisplayName : null;
        const isRename = forceRenamePrompt && !!existingDisplayName;
        forceRenamePrompt = false;

        if (!displayName) {
            // no saved name, prompt. cancel skips the submission (we'll ask next time)
            const cleaned = cleanName(data.Nickname).slice(0, 15);
            const suggestion = (cleaned && cleaned.toLowerCase() !== "player") ? cleaned : "";
            displayName = await askDisplayName(suggestion, isRename, fb, data.Id);
            if (!displayName) return;
        }

        cachedDisplayNames.set(data.Id, displayName);

        const payload = {
            nickname: (data.Nickname ?? "").slice(0, 500),
            displayName,
            ratings: {
                Competitive3v3: data.ModesGlicko?.Competitive3v3?.displayRating ?? null,
                Competitive2v2: data.ModesGlicko?.Competitive2v2?.displayRating ?? null,
                Competitive1v1: data.ModesGlicko?.Competitive1v1?.displayRating ?? null,
                Casual: data.ModesGlicko?.Casual?.displayRating ?? null,
            },
            stats: {
                Competitive3v3: data.ModesData?.Competitive3v3 ?? null,
                Competitive2v2: data.ModesData?.Competitive2v2 ?? null,
                Competitive1v1: data.ModesData?.Competitive1v1 ?? null,
                Casual: data.ModesData?.Casual ?? null,
            },
            xp: data.AccountXp ?? 0,
            equippedSkinId: data.EquippedSkinId ?? null,
            lastUpdated: new Date().toISOString(),
            sourceUserId: data.Id,
            deviceId: getDeviceId(),
            scriptVersion: SCRIPT_VERSION,
            versionNum: SCRIPT_VERSION_NUM,
            lastWriteAt: fb.serverTimestamp(),
        };

        // load clan before the snapshot key or a first-of-session sync misses the tag
        if (!clanLoaded || clanLoadedForAccount !== data.Id) {
            await loadClanData(true);
        }

        // clan tag is part of the snapshot so a tag change alone forces a resync.
        // Rename always bypasses the "unchanged" skip.
        const currentClanTag = (clanLoadedForAccount === data.Id && myClan) ? (myClan.tag ?? "") : "";
        const snapshotKey = JSON.stringify({
            displayName, ratings: payload.ratings, stats: payload.stats,
            xp: payload.xp, equippedSkinId: payload.equippedSkinId,
            clanTag: currentClanTag,
        });
        const now = Date.now();
        const unchanged = lastSyncSnapshot.get(data.Id) === snapshotKey;
        const withinCooldown = (now - (lastSyncTime.get(data.Id) ?? 0)) < SYNC_COOLDOWN_MS;

        if (!isRename && (unchanged || withinCooldown)) {
            // still refresh ranks once per session
            refreshRanks(fb, data);
            return;
        }

        let writeOk = false;
        try {
            logWrite("script_submissions");
            await fb.setDoc(docRef, payload, { merge: true });
            // cache AFTER success, otherwise a rejected write looks "unchanged"
            // next time and never retries
            lastSyncTime.set(data.Id, now);
            lastSyncSnapshot.set(data.Id, snapshotKey);
            writeOk = true;
            clearError();
        } catch (e) {
            console.error("[RG HUD] Leaderboard submission failed:", e);
            showError("Stats submission failed -- check console");
        }

        // don't publish partial state; leave cooldown open for a retry
        if (!writeOk) return;
        await syncToRealLeaderboard(fb, data, displayName);
        refreshRanks(fb, data, true);
        refreshClanViewIfOpen();
        applyTitle(); // clan-lead may have flipped since updateMomentum
    }

    const REAL_LEADERBOARD_COLLECTION = "leaderboard";

    // serialize per player+mode so races can't create duplicate docs
    const upsertLocks = new Map();

    // finds this player's entry for one playlist by sourceUserId. merge:true
    // preserves hand-set fields (flag, icons, glowColor). creates if missing.
    async function upsertPlaylistEntry(fb, sourceUserId, playlist, fields) {
        const lockKey = `${sourceUserId}_${playlist}`;
        const previous = upsertLocks.get(lockKey) || Promise.resolve();

        const current = previous.then(async () => {
            const cacheKey = `${sourceUserId}_${playlist}`;
            const cachedId = knownDocIds.get(cacheKey);

            // identifying fields on every write so rules can blacklist-check merges
            const fullFields = {
                ...fields,
                sourceUserId,
                playlist,
                deviceId: getDeviceId(),
                scriptVersion: SCRIPT_VERSION,
                versionNum: SCRIPT_VERSION_NUM,
                lastWriteAt: fb.serverTimestamp(),
            };

            try {
                if (cachedId) {
                    logWrite(`leaderboard/${playlist} (cached id)`);
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, cachedId), fullFields, { merge: true });
                    clearError();
                    return true;
                }

                const q = fb.query(
                    fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                    fb.where("sourceUserId", "==", sourceUserId),
                    fb.where("playlist", "==", playlist)
                );

                const existing = await fb.getDocs(q);
                if (existing.size > 1) {
                    console.warn(
                        `[RG HUD] ⚠️ Found ${existing.size} leaderboard documents matching sourceUserId=${sourceUserId} playlist=${playlist}. ` +
                        `Only the first one found will be updated; the rest will go stale. Delete the extras in Firestore.`
                    );
                }
                if (!existing.empty) {
                    const docId = existing.docs[0].id;
                    knownDocIds.set(cacheKey, docId);
                    logWrite(`leaderboard/${playlist} (found via query)`);
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, docId), fullFields, { merge: true });
                } else {
                    logWrite(`leaderboard/${playlist} (new doc)`);
                    const newDoc = await fb.addDoc(fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION), fullFields);
                    knownDocIds.set(cacheKey, newDoc.id);
                }
                clearError();
                return true;
            } catch (e) {
                console.error(`[RG HUD] Real leaderboard sync failed for ${playlist}:`, e);
                showError(`Leaderboard sync failed for ${playlist} -- check console`);
                return false;
            }
        });

        upsertLocks.set(lockKey, current);
        return current;
    }

    // last-written state per player+playlist. a 3v3 match only touches 3v3+wins,
    // so 1v1/2v2 skip. sessionStorage-backed so refresh doesn't full-burst.
    const lastEntryState = new Map(
        (() => {
            try { return JSON.parse(sessionStorage.getItem("rgHudEntryState") ?? "[]"); }
            catch (e) { return []; }
        })()
    );

    function saveEntryState() {
        try {
            sessionStorage.setItem("rgHudEntryState", JSON.stringify([...lastEntryState]));
        } catch (e) {}
    }

    // v13.6 -------- Match audit trail --------
    // append-only receipt in match_audits. every player in the match writes
    // their own, a fabricated match has no corroborating audits.
    // fire-and-forget, non-fatal on failure (rules may not allow it yet).
    async function writeMatchAudit(prevRatings, opponents) {
        try {
            if (!lastKnownPlayerData) return;
            const fb = await initFirebase();
            if (!fb) return;
            const g = lastKnownPlayerData.ModesGlicko || {};
            const deltas = {};
            const afters = {};
            let anyChange = false;
            for (const mode of ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"]) {
                const after = g[mode]?.displayRating;
                const before = prevRatings[mode];
                if (typeof after === "number") afters[mode] = after;
                if (typeof after === "number" && typeof before === "number" && after !== before) {
                    deltas[mode] = after - before;
                    anyChange = true;
                }
            }
            if (!anyChange) return; // non-ranked or resync with no change
            const opponentList = (Array.isArray(opponents) ? opponents : [])
                .filter(p => p && p.uid && p.uid !== lastKnownPlayerData.Id)
                .map(p => ({ uid: String(p.uid).slice(0, 64), name: String(p.name || "").slice(0, 64) }))
                .slice(0, 8); // 3v3 max is 6, leave headroom
            const audit = {
                sourceUserId: lastKnownPlayerData.Id,
                deviceId: getDeviceId(),
                versionNum: SCRIPT_VERSION_NUM,
                deltas,
                ratingsAfter: afters,
                opponents: opponentList,
                ts: fb.serverTimestamp(),
                clientTs: Date.now(),
            };
            logWrite("match_audits");
            await fb.addDoc(fb.collection(fb.db, "match_audits"), audit);
            dbg(`match audit written (${Object.keys(deltas).length} mode deltas, ${opponentList.length} opponents)`);
        } catch (e) {
            // best-effort. HUD keeps working, we just skip the audit.
            dbg("match audit write failed (non-fatal): " + (e && e.message ? e.message : e));
        }
    }

    // ---------- Leaderboard opponent popup ----------
    // slides in when a match starts against someone in the leaderboard cache.
    // cache + config live in their own localStorage keys so the existing
    // near-real-time rank stuff is untouched.

    const RG_LB_CACHE_KEY = "rgHudLbCache_v1";
    const RG_LB_CONFIG_KEY = "rgHudRemoteConfig_v1";
    const RG_LB_CONFIG_TTL_MS = 60 * 60 * 1000;
    const RG_LB_MODES = ["Competitive1v1", "Competitive2v2", "Competitive3v3"];
    // leaderboard docs store playlist as "1v1"/"2v2"/"3v3", not the mode name
    const RG_LB_MODE_TO_PLAYLIST = { Competitive1v1: "1v1", Competitive2v2: "2v2", Competitive3v3: "3v3" };
    const RG_LB_TOP_N = 100;
    const RG_LB_DEFAULT_CONFIG = {
        popupDurationMs: 6000,
        popupEnabled: true,
        cacheRefreshHours: 24,
        minRankToShow: 100,
    };

    let _remoteConfigMemo = null;
    let _lbCacheMemo = null;
    let _lbCacheInFlight = null;      // shared promise so concurrent callers don't re-fetch
    let _lbCacheFailUntil = 0;        // cooldown after a failed fetch to avoid hammering
    const RG_LB_FAIL_COOLDOWN_MS = 60 * 1000;
    let _matchFormat = null;
    let _matchPlayerCount = 0;
    let _selfTeam = null;
    let _shownPopupsThisMatch = new Set();
    let _deferredMatch = null;

    async function fetchRemoteConfig() {
        try {
            const fb = await initFirebase();
            if (!fb) return null;
            const snap = await fb.getDoc(fb.doc(fb.db, "atlas_config", "hud"));
            if (!snap.exists()) return null;
            const raw = snap.data() || {};
            return { ...RG_LB_DEFAULT_CONFIG, ...raw, fetchedAt: Date.now() };
        } catch (e) {
            dbg("remote config fetch failed: " + (e && e.message ? e.message : e));
            return null;
        }
    }

    async function getRemoteConfig() {
        if (_remoteConfigMemo && Date.now() - _remoteConfigMemo.fetchedAt < RG_LB_CONFIG_TTL_MS) {
            return _remoteConfigMemo;
        }
        try {
            const cached = JSON.parse(localStorage.getItem(RG_LB_CONFIG_KEY) || "null");
            if (cached && Date.now() - cached.fetchedAt < RG_LB_CONFIG_TTL_MS) {
                _remoteConfigMemo = cached;
                return cached;
            }
        } catch (e) {}
        const fresh = await fetchRemoteConfig();
        if (fresh) {
            _remoteConfigMemo = fresh;
            try { localStorage.setItem(RG_LB_CONFIG_KEY, JSON.stringify(fresh)); } catch (e) {}
            return fresh;
        }
        return { ...RG_LB_DEFAULT_CONFIG, fetchedAt: 0 };
    }

    async function fetchLeaderboardCache() {
        try {
            const fb = await initFirebase();
            if (!fb) return null;
            const cache = { modes: {}, fetchedAt: Date.now() };
            for (const mode of RG_LB_MODES) {
                const q = fb.query(
                    fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                    fb.where("playlist", "==", RG_LB_MODE_TO_PLAYLIST[mode]),
                    fb.orderBy("mmr", "desc"),
                    fb.limit(RG_LB_TOP_N),
                );
                const snap = await fb.getDocs(q);
                const entries = [];
                let rank = 0;
                snap.forEach(doc => {
                    rank++;
                    const d = doc.data();
                    entries.push({ uid: d.sourceUserId, name: d.name, mmr: d.mmr, rank });
                });
                cache.modes[mode] = entries;
            }
            dbg(`leaderboard cache refreshed (${RG_LB_MODES.map(m => `${m.replace("Competitive","")}:${cache.modes[m].length}`).join(", ")})`);
            return cache;
        } catch (e) {
            dbg("leaderboard cache fetch failed: " + (e && e.message ? e.message : e));
            return null;
        }
    }

    async function getLeaderboardCache() {
        const cfg = await getRemoteConfig();
        const ttl = (cfg.cacheRefreshHours || 24) * 60 * 60 * 1000;
        if (_lbCacheMemo && Date.now() - _lbCacheMemo.fetchedAt < ttl) return _lbCacheMemo;
        try {
            const cached = JSON.parse(localStorage.getItem(RG_LB_CACHE_KEY) || "null");
            if (cached && Date.now() - cached.fetchedAt < ttl) {
                _lbCacheMemo = cached;
                return cached;
            }
        } catch (e) {}
        // back off if we just failed — usually a missing index or perms issue,
        // no point hammering the same broken query for every roster entry.
        if (Date.now() < _lbCacheFailUntil) return null;
        // share one in-flight fetch so 4 roster entries don't spawn 4 requests
        if (_lbCacheInFlight) return _lbCacheInFlight;
        _lbCacheInFlight = (async () => {
            try {
                const fresh = await fetchLeaderboardCache();
                if (fresh) {
                    _lbCacheMemo = fresh;
                    try { localStorage.setItem(RG_LB_CACHE_KEY, JSON.stringify(fresh)); } catch (e) {}
                    return fresh;
                }
                _lbCacheFailUntil = Date.now() + RG_LB_FAIL_COOLDOWN_MS;
                return null;
            } finally {
                _lbCacheInFlight = null;
            }
        })();
        return _lbCacheInFlight;
    }

    function lookupInCache(cache, uid, mode) {
        if (!cache || !cache.modes || !uid) return null;
        const entries = cache.modes[mode];
        if (!entries) return null;
        return entries.find(e => e.uid === uid) || null;
    }

    function tierColorForRank(rank) {
        if (rank <= 3) return "#ffd700";
        if (rank <= 10) return "#c77dff";
        if (rank <= 25) return "#00d4ff";
        return "#9aa5ad";
    }

    function modeLabel(mode) {
        if (mode === "Competitive1v1") return "Competitive 1v1";
        if (mode === "Competitive2v2") return "Competitive 2v2";
        if (mode === "Competitive3v3") return "Competitive 3v3";
        return mode;
    }

    function ensureLbPopupStyles() {
        if (document.getElementById("rgLbPopupStyle")) return;
        const style = document.createElement("style");
        style.id = "rgLbPopupStyle";
        style.textContent = `
#rgLbPopupStack {
  position: fixed; top: 20px; right: 20px;
  display: flex; flex-direction: column; gap: 10px;
  z-index: 999999998; pointer-events: none;
}
.rg-lb-popup {
  width: 300px;
  background: linear-gradient(180deg, rgba(28,43,58,0.96), rgba(13,20,27,0.96));
  border: 1px solid #00bfff;
  border-radius: 10px;
  padding: 12px 14px;
  color: #d7f3ff;
  font-family: Arial, sans-serif;
  box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,191,255,0.15), 0 0 24px rgba(0,191,255,0.25);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateX(24px) translateY(-4px);
  transition: opacity 0.3s ease, transform 0.3s cubic-bezier(.16,.9,.28,1.15);
  pointer-events: auto;
}
.rg-lb-popup.show { opacity: 1; transform: translateX(0) translateY(0); }
.rg-lb-popup::before {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px;
  background: var(--tier-color, #00bfff);
  box-shadow: 0 0 12px var(--tier-color, #00bfff);
}
.rg-lb-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: bold;
  color: var(--tier-color, #00bfff);
  letter-spacing: 1.4px; text-transform: uppercase;
  margin-bottom: 8px;
  text-shadow: 0 0 8px var(--tier-color, #00bfff);
}
.rg-lb-header .rg-lb-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--tier-color, #00bfff);
  box-shadow: 0 0 8px var(--tier-color, #00bfff);
  animation: rg-lb-pulse 1.6s ease-in-out infinite;
}
@keyframes rg-lb-pulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50% { opacity: .5; transform: scale(.85); }
}
.rg-lb-body { display: flex; align-items: center; gap: 12px; }
.rg-lb-rank {
  flex: 0 0 auto; min-width: 58px; height: 58px; padding: 0 8px;
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.15));
  border: 2px solid var(--tier-color, #00bfff);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  box-shadow: inset 0 0 12px rgba(0,0,0,0.4);
}
.rg-lb-rank .rg-lb-hash {
  font-size: 10px; color: var(--tier-color, #00bfff);
  line-height: 1; opacity: .8; margin-bottom: 2px; font-weight: bold;
}
.rg-lb-rank .rg-lb-num {
  font-size: 22px; font-weight: 900;
  color: var(--tier-color, #00bfff);
  line-height: 1;
  font-family: "SF Mono", Consolas, monospace;
  letter-spacing: -1px;
}
.rg-lb-info { flex: 1 1 auto; min-width: 0; }
.rg-lb-name {
  font-size: 15px; font-weight: bold; color: #ffffff;
  line-height: 1.2;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 180px;
}
.rg-lb-mode {
  display: inline-block; margin-top: 4px; padding: 2px 8px;
  font-size: 10px; font-weight: bold; letter-spacing: .5px;
  background: rgba(0,191,255,0.12);
  border: 1px solid #00bfff88;
  color: #00bfff;
  border-radius: 999px;
}
.rg-lb-teammate {
  margin-top: 10px; padding-top: 8px;
  border-top: 1px solid rgba(0,191,255,0.15);
  font-size: 11px; color: #a8c3d3;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.rg-lb-teammate .rg-lb-lbl { opacity: .7; text-transform: uppercase; letter-spacing: 1px; font-size: 9px; }
.rg-lb-teammate .rg-lb-tname {
  color: #fff; font-weight: bold; max-width: 140px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rg-lb-teammate .rg-lb-trank {
  padding: 1px 6px; border-radius: 4px; font-weight: bold; font-size: 10px;
  background: rgba(0,0,0,0.35);
}
`;
        document.head.appendChild(style);
    }

    async function showLbOpponentPopup({ rank, name, mode, isTeammate }) {
        try {
            ensureLbPopupStyles();
            const cfg = await getRemoteConfig();
            if (cfg.popupEnabled === false) return;
            const dur = cfg.popupDurationMs || 6000;
            let stack = document.getElementById("rgLbPopupStack");
            if (!stack) {
                stack = document.createElement("div");
                stack.id = "rgLbPopupStack";
                document.body.appendChild(stack);
            }
            const el = document.createElement("div");
            el.className = "rg-lb-popup";
            el.style.setProperty("--tier-color", tierColorForRank(rank));
            const headerLabel = isTeammate ? "LEADERBOARD TEAMMATE" : "LEADERBOARD OPPONENT";
            el.innerHTML = `
                <div class="rg-lb-header"><span class="rg-lb-dot"></span>${headerLabel}</div>
                <div class="rg-lb-body">
                    <div class="rg-lb-rank">
                        <div class="rg-lb-hash">RANK</div>
                        <div class="rg-lb-num">#${rank}</div>
                    </div>
                    <div class="rg-lb-info">
                        <div class="rg-lb-name">${escapeHtml(name)}</div>
                        <div class="rg-lb-mode">${modeLabel(mode)}</div>
                    </div>
                </div>
            `;
            stack.appendChild(el);
            requestAnimationFrame(() => el.classList.add("show"));
            setTimeout(() => {
                el.classList.remove("show");
                setTimeout(() => el.remove(), 320);
            }, dur);
        } catch (e) {
            dbg("showLbOpponentPopup threw: " + (e && e.message ? e.message : e));
        }
    }

    function derivedFormatFromPlayerCount(n) {
        if (n === 2) return "Competitive1v1";
        if (n === 3 || n === 4) return "Competitive2v2";
        if (n === 5 || n === 6) return "Competitive3v3";
        return null;
    }

    function resetMatchPopupState() {
        _matchFormat = null;
        _matchPlayerCount = 0;
        _selfTeam = null;
        _shownPopupsThisMatch = new Set();
        _deferredMatch = null;
    }

    // called when a real-uid roster entry lands. figures out opponent vs teammate,
    // fires the popup if the mode is known, otherwise stashes for postmortem.
    async function onRosterEntry(entry) {
        try {
            const selfUid = lastKnownPlayerData?.Id;
            if (!selfUid) return;
            if (entry.uid === selfUid) {
                if (entry.team) _selfTeam = entry.team;
                for (const p of _liveRoster) {
                    if (p.uid !== selfUid) await checkOneOpponent(p);
                }
                return;
            }
            if (_selfTeam) await checkOneOpponent(entry);
        } catch (e) {
            dbg("onRosterEntry threw: " + (e && e.message ? e.message : e));
        }
    }

    async function checkOneOpponent(entry) {
        if (entry.uid === lastKnownPlayerData?.Id) return; // never popup ourselves
        const isTeammate = entry.team && _selfTeam && entry.team === _selfTeam;
        if (!_matchFormat) {
            if (!_deferredMatch) _deferredMatch = { opponents: [], teammates: [] };
            const bucket = isTeammate ? _deferredMatch.teammates : _deferredMatch.opponents;
            if (!bucket.some(p => p.uid === entry.uid)) bucket.push(entry);
            return;
        }
        if (_shownPopupsThisMatch.has(entry.uid)) return;
        _shownPopupsThisMatch.add(entry.uid);
        const cache = await getLeaderboardCache();
        if (!cache) { dbg(`popup skip: no leaderboard cache available`); return; }
        const hit = lookupInCache(cache, entry.uid, _matchFormat);
        if (!hit) {
            const role = isTeammate ? "teammate" : "opponent";
            dbg(`popup skip: ${role} "${entry.name}" (${entry.uid.slice(0,8)}...) not in ${_matchFormat} top ${RG_LB_TOP_N}`);
            return;
        }
        const cfg = await getRemoteConfig();
        if (hit.rank > (cfg.minRankToShow || 100)) {
            dbg(`popup skip: "${entry.name}" is #${hit.rank}, below minRankToShow ${cfg.minRankToShow}`);
            return;
        }
        dbg(`popup fire: #${hit.rank} ${isTeammate ? "teammate" : "opponent"} "${entry.name}" in ${_matchFormat}`);
        showLbOpponentPopup({ rank: hit.rank, name: entry.name, mode: _matchFormat, isTeammate });
    }

    // for 3/4-player matches we defer to match end when ratings deltas
    // reveal the true mode. this runs after tryParseAndUpdate.
    async function firePostmortemPopupsIfDeferred(prevRatings) {
        try {
            if (!_deferredMatch) return;
            const g = lastKnownPlayerData?.ModesGlicko || {};
            const changedRanked = RG_LB_MODES.filter(m => {
                const before = prevRatings[m];
                const after = g[m]?.displayRating;
                return typeof after === "number" && typeof before === "number" && after !== before;
            });
            if (changedRanked.length !== 1) return;
            const mode = changedRanked[0];
            const cache = await getLeaderboardCache();
            if (!cache) return;
            const cfg = await getRemoteConfig();
            const fire = (list, isTeammate) => {
                for (const p of list) {
                    const hit = lookupInCache(cache, p.uid, mode);
                    if (!hit) continue;
                    if (hit.rank > (cfg.minRankToShow || 100)) continue;
                    showLbOpponentPopup({ rank: hit.rank, name: p.name, mode, isTeammate });
                }
            };
            fire(_deferredMatch.opponents, false);
            fire(_deferredMatch.teammates, true);
        } catch (e) {
            dbg("firePostmortemPopupsIfDeferred threw: " + (e && e.message ? e.message : e));
        }
    }

    async function syncToRealLeaderboard(fb, data, displayName) {
        const sourceUserId = data.Id;

        // piggy-back: refresh this member's MMR in the clan doc, get tag back
        const clanInfo = await updateMyClanMMR(fb, data);
        const shownName = clanInfo?.tag ? `[${clanInfo.tag}] ${displayName}` : displayName;

        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
            const mmr = data.ModesGlicko?.[mode]?.displayRating;
            if (typeof mmr !== "number") continue; // never played this mode
            await upsertIfChanged(fb, sourceUserId, playlist, { name: shownName, mmr });
        }

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        await upsertIfChanged(fb, sourceUserId, "wins", {
            name: shownName,
            wins: totalWins,
            matches: totalMatches,
        });
    }

    // refresh my ranked MMR in the clan doc + recompute totalMMR.
    // returns { tag } for the leaderboard name prefix. best-effort.
    async function updateMyClanMMR(fb, data) {
        const uid = data.Id;
        try {
            if (!clanLoaded || clanLoadedForAccount !== uid) await loadClanData(true);
            if (!myClan) return null;

            // capture tag first, leaderboard prefix must not depend on the MMR write
            const tag = myClan.tag ?? "";

            const g = data.ModesGlicko;
            const rankedModes = ["Competitive3v3", "Competitive2v2", "Competitive1v1"];
            const myMMR = rankedModes.reduce((s, m) =>
                s + (typeof g?.[m]?.displayRating === "number" ? g[m].displayRating : 0), 0);

            await loadEventConfig(fb);
            await loadClanRolePerms(fb);

            const prevMine = (myClan.members ?? []).find(m => m.userId === uid)?.mmr;
            if (prevMine !== myMMR) {
                try {
                    // syncedAt: client ms on my member entry so teammates get
                    // per-member freshness ("2m ago"). serverTimestamp() isn't
                    // allowed inside array elements anyway.
                    const members = (myClan.members ?? []).map(m =>
                        m.userId === uid ? { ...m, mmr: myMMR, syncedAt: Date.now() } : m
                    );
                    const totalMMR = members.reduce((s, m) => s + (m.mmr ?? 0), 0);
                    // stamp server time, we read it back to calibrate serverNow()
                    const writeClanMMR = () => fb.setDoc(fb.doc(fb.db, "clans", myClan.id),
                        { members, totalMMR, lastSyncAt: fb.serverTimestamp() }, { merge: true });
                    try {
                        await writeClanMMR();
                    } catch (firstErr) {
                        // one retry, otherwise a transient fail stalled visible
                        // contribution until the NEXT match
                        console.warn("[RG HUD] Clan MMR write failed, retrying in 5s:", firstErr);
                        await new Promise(r => setTimeout(r, 5000));
                        await writeClanMMR();
                    }
                    myClan.members = members;
                    myClan.totalMMR = totalMMR;

                    // one-time serverNow calibration per session
                    if (serverNowOffset === null) {
                        try {
                            const back = await fb.getDoc(fb.doc(fb.db, "clans", myClan.id));
                            const ts = back.exists() ? back.data().lastSyncAt : null;
                            if (ts?.toMillis) learnServerTime(ts.toMillis());
                        } catch (e) {}
                    }

                    // throttled directory rebuild, instant local, Firestore at most every 3m
                    await refreshDirectoryThrottled(fb);
                } catch (writeErr) {
                    // best-effort, never strip the tag on failure
                    console.warn("[RG HUD] Clan MMR write failed (tag still applies):", writeErr);
                    // v13.6: surface persistent failures. 13.5 was silent and
                    // broke the whole event score loop for the session.
                    showError("Clan sync failing — event score may be stale");
                }
            }

            // capture event baseline on first sync during an active event
            await maybeCaptureEventBaseline(fb, uid, myMMR);

            return { tag };
        } catch (e) {
            console.warn("[RG HUD] Clan lookup failed:", e);
            return null;
        }
    }

    async function upsertIfChanged(fb, sourceUserId, playlist, fields) {
        const stateKey = `${sourceUserId}_${playlist}`;
        const newState = JSON.stringify(fields);

        if (lastEntryState.get(stateKey) === newState) {
            return; // unchanged — skip
        }

        const ok = await upsertPlaylistEntry(fb, sourceUserId, playlist, fields);
        // only cache on success, a failed write would poison the cache and
        // prevent any future retry
        if (ok) {
            lastEntryState.set(stateKey, newState);
            saveEntryState();
        }
    }

    // ---------- Rank lookup ----------
    // count aggregation: "how many entries have higher mmr than mine" = 1 cheap
    // server-side count, not a collection download. cached; force=true after
    // our own writes, otherwise once per session.
    //
    // we only re-query modes whose MMR actually moved since last check. someone
    // else climbing could shuffle you, but that drift isn't worth 4 reads/match.

    let ranksFetchedThisSession = false;
    const lastRankedMMR = new Map(); // playlist -> mmr at last query

    async function refreshRanks(fb, data, force = false) {
        if (!force && ranksFetchedThisSession) return;

        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        try {
            for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
                const mmr = data.ModesGlicko?.[mode]?.displayRating;
                if (typeof mmr !== "number") continue;

                // skip modes whose MMR hasn't moved since last query. usually
                // skips 2 of 3 modes on a match-triggered refresh, saves ~4
                // reads/match. cold session still refreshes everything.
                if (ranksFetchedThisSession && lastRankedMMR.get(playlist) === mmr) continue;

                const q = fb.query(
                    fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                    fb.where("playlist", "==", playlist),
                    fb.where("mmr", ">", mmr)
                );
                const snapshot = await fb.getCountFromServer(q);
                const rank = snapshot.data().count + 1;
                cachedRanks.set(playlist, rank);
                lastRankedMMR.set(playlist, mmr);

                // gap to next rank up: lowest-MMR entry still above us.
                // skipped when already #1.
                if (rank > 1) {
                    try {
                        const nextQ = fb.query(
                            fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                            fb.where("playlist", "==", playlist),
                            fb.where("mmr", ">", mmr),
                            fb.orderBy("mmr", "asc"),
                            fb.limit(1)
                        );
                        const nextSnap = await fb.getDocs(nextQ);
                        if (!nextSnap.empty) {
                            const nextMmr = nextSnap.docs[0].data().mmr;
                            cachedMmrToNext.set(playlist, Math.max(0, nextMmr - mmr + 1));
                        }
                    } catch (e) {
                        // gap is nice-to-have, ignore failures
                    }
                } else {
                    cachedMmrToNext.delete(playlist);
                }
            }

            ranksFetchedThisSession = true;

            checkRankTransitions();

            // re-render with fresh ranks
            if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
        } catch (e) {
            // rank display is nice-to-have, don't crash on failure
            console.warn("[RG HUD] Rank lookup failed:", e);
        }
    }

    // ---------- Network capture ----------

    // last-known equipped skin, needed by partial equipSkin responses
    let lastKnownPlayerData = null;

    // ---------- Last-game lobby roster (feeds Forge's Imposter section) ----------
    // game logs "Initialized stats for player X" for each player when a match
    // forms. we collect names while the match runs, freeze on matchEnd /
    // LeaveRoom. persisted so a page refresh (Tampermonkey update needs one)
    // doesn't wipe the roster before the user opens Forge, 13.4 shipped that
    // bug and Imposter always showed empty state.
    let lastGamePlayers = [];   // frozen roster of the last match: [{name, uid}]
    try { lastGamePlayers = JSON.parse(localStorage.getItem("rgHudLastRoster") ?? "[]"); }
    catch (e) { pushError(e, "loadLastRoster"); }
    let _liveRoster = [];       // in-progress match: [{name, uid}]

    // "are we actually in a real match right now". set on the first init line
    // with a REAL UserId (warm-up self-inits log empty UserId), cleared on
    // matchEnd/LeaveRoom/new queue. all HUD-restore signals gate on this so
    // a reconnect storm can't resurrect the HUD mid-match.
    // v13.4 bug: includes("OnDisconnected") substring-matched
    // "PhotonConnector:OurOnDisconnected" and restored the HUD on every
    // reconnect attempt.
    let _inMatch = false;

    // v13.6 watchdog timestamps.
    //   _lastInitLineAt      : last real init line, proves console hook is alive
    //   _lastRecoverySignalAt: last menu/reconnect signal
    //   _lastValidRatingsAt  : last successful ModesGlicko parse, proves matchEnd
    //                          shape hasn't changed
    let _lastInitLineAt = 0;
    let _lastRecoverySignalAt = 0;
    let _lastValidRatingsAt = 0;
    let _matchEndArmedAt = 0;
    let _matchEndWatchdogTimer = null;

    function freezeRoster() {
        if (_liveRoster.length) {
            lastGamePlayers = _liveRoster.slice();
            try { localStorage.setItem("rgHudLastRoster", JSON.stringify(lastGamePlayers)); }
            catch (e) { pushError(e, "saveLastRoster"); }
            dbg(`Imposter roster captured: ${lastGamePlayers.length} player(s): ${lastGamePlayers.map(p => p.name).join(", ")}`);
            // repaint Forge live if it's open. can't focus-steal here, you
            // can't be typing in Forge while in a match.
            const fv = document.getElementById("rgForgeView");
            if (fv && fv.style.display !== "none" && typeof RGNF !== "undefined" && RGNF.refresh) {
                RGNF.refresh();
            }
            // clear so a stray second freeze (matchEnd fetch + logged response)
            // can't re-capture stale data
            _liveRoster = [];
        }
    }

    const API_HOST_FRAGMENT = "us-central1-rocketball-23c12.cloudfunctions.net";

    const oldFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await oldFetch.apply(this, args);
        try {
            const url = args[0]?.toString?.() ?? "";
            if (!url.includes(API_HOST_FRAGMENT)) return response;

            const clone = response.clone();
            const text = await clone.text();

            if (url.includes("/v0304_player/matchEnd")) {
                // v13.6: watchdog. if no valid ratings parse within 30s the
                // game probably changed the response shape, surface it
                // instead of letting the HUD freeze on stale numbers.
                _matchEndArmedAt = performance.now();
                if (_matchEndWatchdogTimer) clearTimeout(_matchEndWatchdogTimer);
                _matchEndWatchdogTimer = setTimeout(() => {
                    if (_lastValidRatingsAt < _matchEndArmedAt) {
                        dbgWarn("matchEnd fired but no valid ratings parse in 30s — game may have updated");
                        showError("Match ratings parse failed — game may have updated. Check rgDump().");
                    }
                }, 30 * 1000);
                // snapshot ratings + opponents before update path mutates them,
                // so writeMatchAudit can diff cleanly
                const prevRatings = {
                    Competitive3v3: lastKnownPlayerData?.ModesGlicko?.Competitive3v3?.displayRating,
                    Competitive2v2: lastKnownPlayerData?.ModesGlicko?.Competitive2v2?.displayRating,
                    Competitive1v1: lastKnownPlayerData?.ModesGlicko?.Competitive1v1?.displayRating,
                    Casual: lastKnownPlayerData?.ModesGlicko?.Casual?.displayRating,
                };
                const opponentsSnapshot = _liveRoster.slice();
                tryParseAndUpdate(text);
                dbg(`matchEnd response — roster at ${_liveRoster.length}, restoring HUD`);
                _inMatch = false;
                freezeRoster();
                setAutoVisible(true);
                // fire-and-forget audit write
                writeMatchAudit(prevRatings, opponentsSnapshot);
                // if we deferred the popup for an ambiguous 3/4-player match,
                // the ratings delta now tells us the mode — show it postmortem
                firePostmortemPopupsIfDeferred(prevRatings);
            } else if (url.includes("/v0304_login/login")) {
                tryParseAndUpdate(text);
                // fire the pending-steal verifier here too, login carries
                // the raw nickname before any local processing
                try {
                    const loginData = JSON.parse(text);
                    const rawNick = loginData?.Nickname ?? "";
                    if (rawNick && typeof RGNF !== "undefined" && RGNF.verifyStolenName) {
                        RGNF.verifyStolenName(rawNick);
                    }
                } catch (e) { /* already logged */ }
            } else if (url.includes("/v0304_player/equipSkin")) {
                // response is a bare quoted skin id, e.g. "body.2"
                try {
                    const skinId = JSON.parse(text);
                    if (lastKnownPlayerData) {
                        lastKnownPlayerData.EquippedSkinId = skinId;
                    }
                } catch (e) {}
            }
        } catch (e) {
            // 13.5 swallowed clone.text() throws silently. log them.
            dbg("fetch wrapper threw: " + (e && e.message ? e.message : e));
        }
        return response;
    };

    console.log = function (...args) {
        oldLog.apply(console, args);
        // 13.5: a throw in any branch below unwound the for-loop and every
        // state transition after it was silently missed. wrap it.
        try {
            for (const arg of args) {
                if (typeof arg !== "string") continue;

                // ratings payload also arrives via logged web-request text
                // (login, echoed matchEnd). tryParseAndUpdate dedupes.
                if (arg.includes('"ModesGlicko"')) {
                    const json = arg.substring(arg.indexOf("{"));
                    tryParseAndUpdate(json);
                }

                // ---- Field entry: queue warm-up OR real match forming ----
                // line shape:
                //   ...for player: <markup>Name<size=0> (UserId: abc123, Team: Orange)
                // UserId is the discriminator. warm-up logs the local player
                // with an EMPTY UserId (verified 5x in 7/27 log dump); real
                // match inits always populate it.
                // v13.4 bug: warm-up inits restarted the roster mid-queue.
                if (arg.includes("[PlayerDataManager] Initialized stats for player")) {
                    // v13.6: anchor only on "for player:" + "(UserId:..." so a
                    // future patch adding a field / tweaking spacing doesn't
                    // silently kill roster detection.
                    // also grabs team so we can tell opponents from teammates.
                    const m = arg.match(/Initialized stats for player\s*:?\s*(.*?)\s*\(UserId:\s*([^,)]+)(?:,\s*Team:\s*([A-Za-z]+))?/);
                    const nm = (m?.[1] ?? "").trim();
                    const uid = (m?.[2] ?? "").trim();
                    const team = (m?.[3] ?? "").trim() || null;
                    if (nm && uid) {
                        _lastInitLineAt = performance.now();
                        setAutoVisible(false); // real match — hide HUD
                        if (!_inMatch) {
                            _liveRoster = [];
                            _inMatch = true;
                            dbg(`match forming — roster reset, first player "${nm}"`);
                        }
                        // dedupe by uid, names collide, mid-match backfills should ADD
                        if (!_liveRoster.some(p => p.uid === uid)) {
                            const entry = { name: nm, uid, team };
                            _liveRoster.push(entry);
                            dbg(`roster +1 "${nm}"${team ? ` (${team})` : ""} (${_liveRoster.length} total)`);
                            // fire the leaderboard-opponent popup check
                            onRosterEntry(entry);
                        }
                    } else if (nm) {
                        dbg(`warm-up init "${nm}" (empty uid) — ignored, inMatch=${_inMatch}`);
                    } else {
                        // canary: if this line ever fails, the game format changed.
                        // yellow dot so users notice without DevTools.
                        dbgWarn(`init line FAILED to parse — game format may have changed`);
                        dbg(`init line raw: ${arg.slice(0, 120)}`);
                    }
                }

                // "Starting game with N players" fires right before the real
                // uid inits. tells us format when it's unambiguous (2, 5, 6).
                if (arg.includes("Starting game with") && arg.includes("players")) {
                    const m = arg.match(/Starting game with\s+(\d+)\s+players/);
                    if (m) {
                        _matchPlayerCount = parseInt(m[1], 10);
                        _matchFormat = derivedFormatFromPlayerCount(_matchPlayerCount);
                        dbg(`match player count = ${_matchPlayerCount}, format = ${_matchFormat || "unknown"}`);
                        // pre-warm the cache in the background so it's ready when roster fills
                        getLeaderboardCache();
                    }
                }

                // ---- Left match another way (rage-quit, back-out) ----
                // LeaveRoom / fresh queue can't coexist with mid-match. freeze
                // and clear so Imposter survives early exits.
                if (arg.includes("PhotonNetwork:LeaveRoom") ||
                    arg.includes("Set player matchmaking start time")) {
                    if (_inMatch) {
                        dbg(`left mid-match — roster frozen at ${_liveRoster.length}`);
                        freezeRoster();
                    }
                    _inMatch = false;
                    // new match is being queued — clear popup state
                    resetMatchPopupState();
                }

                // ---- Return-to-menu / recovery signals ----
                // v13.4 used "OnJoinedRoom"/"OnLeftRoom" (never appear) and
                // "OnDisconnected" (only matched as substring of
                // "OurOnDisconnected"). these are the actual log strings.
                // gate restore on !_inMatch or a reconnect storm respawns the HUD.
                // "Starting SetNickname" covers practice/private, which emit
                // no room strings on exit.
                // v13.6: word-boundaries on Our* to guard against the same
                // substring-match class of bug.
                if (/\bOurOnDisconnected\b/.test(arg) || arg.includes("Starting SetNickname") ||
                    /\bOurOnConnectedToMaster\b/.test(arg)) {
                    _lastRecoverySignalAt = performance.now();
                    if (!_inMatch) setAutoVisible(true);
                    else dbg(`recovery signal suppressed (mid-match): ${arg.slice(0, 60)}`);
                }
            }
        } catch (e) {
            dbg("console.log hook threw: " + (e && e.message ? e.message : e));
        }
    };

    // ---------- Clan events (Clan Clash) ----------
    // config lives in events/current (admin-only). timing uses serverTimestamp
    // so device clocks can't spoof it. each member's baseline MMR is captured
    // on their first sync after the event starts. score = sum(current - baseline).

    let eventConfig = null;       // { name, startTime(ms), endTime(ms) } or null
    let eventConfigLoaded = false;
    let serverNowOffset = null;   // (serverTime - deviceTime), ms

    // event-time perms, edit events/current in Firestore, no redeploy.
    // missing keys fall back to these defaults.
    //   allowJoin/Leave/Kick/Approve/Disband/RoleChange/Transfer/RenameClan/ClanCreate
    const EVENT_PERM_DEFAULTS = {
        allowJoin:        true,   // opened mid-event per feedback
        allowLeave:       false,  // can't dodge a losing team
        allowKick:        true,
        allowApprove:     true,
        allowDisband:     false,  // freeze rosters
        allowRoleChange:  false,  // role changes shift attribution — freeze
        allowTransfer:    false,
        allowRenameClan:  false,
        allowClanCreate:  true,   // new clans don't affect anyone else
    };

    async function loadEventConfig(fb, force = false) {
        if (eventConfigLoaded && !force) return eventConfig;
        try {
            const snap = await fb.getDoc(fb.doc(fb.db, "events", "current"));
            if (snap.exists()) {
                const d = snap.data();
                // merge over defaults so partial perms still get safe fallbacks
                const storedPerms = (d.perms && typeof d.perms === "object") ? d.perms : {};
                eventConfig = {
                    name: d.name ?? "Clan Event",
                    startTime: d.startTime?.toMillis ? d.startTime.toMillis() : (d.startTime ?? 0),
                    endTime: d.endTime?.toMillis ? d.endTime.toMillis() : (d.endTime ?? 0),
                    // applies outside the event window too
                    maxMembers: (typeof d.maxMembers === "number") ? d.maxMembers : null,
                    perms: { ...EVENT_PERM_DEFAULTS, ...storedPerms },
                };
            } else {
                eventConfig = null;
            }
            eventConfigLoaded = true;
        } catch (e) {
            console.warn("[RG HUD] Event config load failed:", e);
        }
        return eventConfig;
    }

    // true = allowed now. outside an active event, everything is allowed.
    function eventPerm(key) {
        if (eventPhase() !== "active") return true;
        const p = eventConfig?.perms || EVENT_PERM_DEFAULTS;
        return p[key] !== false;
    }

    // ---------- Clan role permissions (server-driven) ----------
    // defaults match the old hardcoded behavior. admin/clanPerms can override
    // any subset, e.g. { elder: { kick: true } }.
    const CLAN_ROLE_PERM_DEFAULTS = {
        leader:   { editClanInfo: true,  tagStyle: true,  kick: true,  approve: true,  roleChange: true,  transfer: true,  disband: true  },
        coleader: { editClanInfo: false, tagStyle: false, kick: true,  approve: true,  roleChange: true,  transfer: false, disband: false },
        elder:    { editClanInfo: false, tagStyle: false, kick: false, approve: true,  roleChange: false, transfer: false, disband: false },
        member:   { editClanInfo: false, tagStyle: false, kick: false, approve: false, roleChange: false, transfer: false, disband: false },
    };
    let clanRolePerms = null;        // stored overrides from admin/clanPerms, or null
    let clanRolePermsLoaded = false;

    async function loadClanRolePerms(fb, force = false) {
        if (clanRolePermsLoaded && !force) return;
        try {
            const snap = await fb.getDoc(fb.doc(fb.db, "admin", "clanPerms"));
            clanRolePerms = snap.exists() ? snap.data() : null;
            clanRolePermsLoaded = true;
        } catch (e) {
            console.warn("[RG HUD] Clan role perms load failed:", e);
        }
    }

    // stored bool wins; missing = default. unknown role -> member (most restrictive).
    function rolePerm(role, key) {
        const r = (role && CLAN_ROLE_PERM_DEFAULTS[role]) ? role : "member";
        const stored = clanRolePerms?.[r]?.[key];
        if (typeof stored === "boolean") return stored;
        return CLAN_ROLE_PERM_DEFAULTS[r][key] === true;
    }

    function myClanRole() {
        const me = (myClan?.members ?? []).find(m => m.userId === myUserId());
        return me?.role ?? "member";
    }

    // offset learned from serverTimestamp round-trips. cosmetic only, never scoring.
    function serverNow() {
        return Date.now() + (serverNowOffset ?? 0);
    }
    function learnServerTime(serverMs) {
        if (typeof serverMs === "number") serverNowOffset = serverMs - Date.now();
    }

    function eventPhase() {
        if (!eventConfig) return "none";
        const now = serverNow();
        if (now < eventConfig.startTime) return "upcoming";
        if (now > eventConfig.endTime) return "ended";
        return "active";
    }

    // startTime doubles as an event id so old baselines are recognized as stale.
    function currentEventId() {
        return eventConfig ? String(eventConfig.startTime) : null;
    }

    async function maybeCaptureEventBaseline(fb, uid, currentMMR) {
        if (!myClan || eventPhase() !== "active") return;
        const evId = currentEventId();

        // baseline from a previous event -> wipe
        let baseline = myClan.eventBaseline ?? {};
        if (myClan.eventId !== evId) {
            baseline = {};
        }
        if (baseline[uid] != null && myClan.eventId === evId) return;

        try {
            baseline[uid] = currentMMR;
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id),
                { eventBaseline: baseline, eventId: evId, eventName: eventConfig.name }, { merge: true });
            myClan.eventBaseline = baseline;
            myClan.eventId = evId;
        } catch (e) {
            console.warn("[RG HUD] Event baseline capture failed:", e);
            // v13.6: without this alert, the member's contribution silently stays at 0
            showError("Event baseline capture failed — your contribution won't count until this recovers");
        }
    }

    function clanBaselineForCurrentEvent(clan) {
        if (!clan || !clan.eventBaseline) return null;
        if (clan.eventId !== currentEventId()) return null; // stale -> no score yet
        return clan.eventBaseline;
    }

    function computeClanEventScore(clan) {
        const baseline = clanBaselineForCurrentEvent(clan);
        if (!baseline) return 0;
        return (clan.members ?? []).reduce((sum, m) => {
            const base = baseline[m.userId];
            if (base == null || typeof m.mmr !== "number") return sum;
            return sum + (m.mmr - base);
        }, 0);
    }

    function myEventContribution(clan, uid) {
        const baseline = clanBaselineForCurrentEvent(clan);
        if (!baseline) return null;
        const base = baseline[uid];
        const me = (clan.members ?? []).find(m => m.userId === uid);
        if (base == null || !me || typeof me.mmr !== "number") return null;
        return me.mmr - base;
    }

    // always includes seconds so the 1s tick has something to change
    function formatCountdown(targetMs) {
        let ms = targetMs - serverNow();
        if (ms < 0) ms = 0;
        const d = Math.floor(ms / 86400000);
        const h = Math.floor((ms % 86400000) / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    // 1s tick. target/phase live on data-* attrs so it no-ops when the span
    // isn't in the DOM. crossing a phase boundary triggers a full re-render.
    let countdownIntervalId = null;
    function tickCountdown() {
        const el = document.getElementById("rgEventCountdown");
        if (!el) return;

        const targetMs = parseInt(el.getAttribute("data-target-ms"), 10);
        if (!Number.isFinite(targetMs)) return;
        const phase = el.getAttribute("data-phase");

        if (serverNow() >= targetMs && (phase === "upcoming" || phase === "active")) {
            refreshClanViewIfOpen();
            applyTitle();
            return;
        }

        const prefix = el.getAttribute("data-prefix") || "";
        const suffix = el.getAttribute("data-suffix") || "";
        const next = prefix + formatCountdown(targetMs) + suffix;
        if (el.textContent !== next) el.textContent = next;
    }

    // sorted by eventScore desc. only clans with a baseline in this event count.
    function eventStandings() {
        const evId = currentEventId();
        return clanDirectory
            .filter(c => c.eventId === evId)
            .slice()
            .sort((a, b) => (b.eventScore ?? 0) - (a.eventScore ?? 0));
    }

    // drives the "👑 Leading the Clash" title (clan-version of KING)
    function isMyClanLeadingClash() {
        if (eventPhase() !== "active") return false;
        if (!myClan) return false;
        const standings = eventStandings();
        return standings.length > 0 && standings[0].id === myClan.id;
    }

    // `clan` may be null (clanless players see the banner without their numbers).
    // returns "" when there's no event.
    function eventBannerHtml(clan, uid) {
        const phase = eventPhase();
        if (phase === "none") return "";

        const gold = "#ffd700";
        const standings = eventStandings();
        const leader = standings[0];

        let countdownSpan;
        if (phase === "upcoming") {
            countdownSpan = `<span id="rgEventCountdown" data-target-ms="${eventConfig.startTime}" data-phase="upcoming" data-prefix="Starts in " data-suffix="">Starts in ${formatCountdown(eventConfig.startTime)}</span>`;
        } else if (phase === "active") {
            countdownSpan = `<span id="rgEventCountdown" data-target-ms="${eventConfig.endTime}" data-phase="active" data-prefix="" data-suffix=" left">${formatCountdown(eventConfig.endTime)} left</span>`;
        } else {
            countdownSpan = `<span>Ended</span>`;
        }

        const header = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <div style="font-weight:bold;color:${gold};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🏆 ${escapeHtml(eventConfig.name)}</div>
                <div style="font-size:10px;opacity:.8;white-space:nowrap;flex-shrink:0;">${countdownSpan}</div>
            </div>
        `;

        let body = "";

        if (phase === "upcoming") {
            if (clan) body = `<div style="font-size:10px;opacity:.7;margin-top:4px;">Play a match once it starts to lock your baseline.</div>`;
        } else if (phase === "active") {
            if (clan) {
                const score = computeClanEventScore(clan);
                const mine = myEventContribution(clan, uid);
                const scoreColor = score >= 0 ? "#00ff66" : "#ff6b6b";
                const contribColor = (mine != null && mine >= 0) ? "#00ff66" : "#ff6b6b";
                const myRank = standings.findIndex(c => c.id === clan.id) + 1;
                const leaderIsMe = leader && leader.id === clan.id;

                // mirrors main-HUD rankBadge but on clan-event standings
                let rankBadgeHtml = "";
                if (myRank > 0) {
                    let rankColor;
                    if (myRank <= 3) rankColor = "#ffd700";
                    else if (myRank <= 10) rankColor = "#c77dff";
                    else if (myRank <= 25) rankColor = "#00d4ff";
                    else rankColor = "#9aa5ad";
                    let tip;
                    if (myRank === 1) {
                        tip = "You're #1! 👑";
                    } else {
                        const ahead = standings[myRank - 2];
                        const gap = (ahead.eventScore ?? 0) - score;
                        tip = `+${gap} MMR to reach #${myRank - 1}`;
                    }
                    // hide "of N" when alone, "#1/1" is just clutter
                    const totalPart = standings.length > 1
                        ? `<span style="opacity:.55;font-weight:normal;"> of ${standings.length}</span>`
                        : "";
                    rankBadgeHtml = `<span class="rgHasTip" data-tip="${tip}" style="color:${rankColor};font-weight:bold;font-size:11px;">#${myRank}${totalPart}</span>`;
                }

                // left col: your clan's numbers
                const leftCol = `
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                        <span style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;">Your Clan</span>
                        ${rankBadgeHtml}
                    </div>
                    <div style="font-size:12px;margin-top:2px;">Score <span style="color:${scoreColor};font-weight:bold;">${score >= 0 ? "+" : ""}${score}</span></div>
                    ${mine == null
                        ? `<div style="font-size:12px;color:#ffcf5b;">Play a match to lock in!</div>`
                        : `<div style="font-size:12px;">Contribution <span style="color:${contribColor};font-weight:bold;">${mine >= 0 ? "+" : ""}${mine}</span></div>`
                    }
                `;

                // right col: leader if not you, challenger if you lead, else lonely
                let rightCol;
                if (leaderIsMe && standings.length > 1) {
                    const challenger = standings[1];
                    const gap = score - (challenger.eventScore ?? 0);
                    rightCol = `
                        <div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;">Challenger</div>
                        <div style="font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${challenger.tag ? `<span style="opacity:.7;">[${escapeHtml(challenger.tag)}]</span> ` : ""}<b>${escapeHtml(challenger.name)}</b>
                        </div>
                        <div style="font-size:11px;opacity:.75;"><span style="color:#00ff66;">${challenger.eventScore >= 0 ? "+" : ""}${challenger.eventScore}</span></div>
                        <div style="font-size:10px;opacity:.6;">Lead by ${gap}</div>
                    `;
                } else if (leader && !leaderIsMe) {
                    const gap = (leader.eventScore ?? 0) - score;
                    rightCol = `
                        <div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;">Leader</div>
                        <div style="font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${leader.tag ? `<span style="opacity:.7;">[${escapeHtml(leader.tag)}]</span> ` : ""}<b>${escapeHtml(leader.name)}</b>
                        </div>
                        <div style="font-size:11px;opacity:.75;"><span style="color:#00ff66;">${leader.eventScore >= 0 ? "+" : ""}${leader.eventScore}</span></div>
                        <div style="font-size:10px;opacity:.6;">+${gap} to catch</div>
                    `;
                } else {
                    rightCol = `
                        <div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;">Standings</div>
                        <div style="font-size:11px;margin-top:4px;opacity:.7;line-height:1.3;">You're the only clan competing so far.</div>
                    `;
                }

                body = `
                    <div style="display:flex;gap:10px;margin-top:6px;align-items:flex-start;">
                        <div style="flex:1;min-width:0;">${leftCol}</div>
                        <div style="width:1px;background:${gold}44;align-self:stretch;flex-shrink:0;"></div>
                        <div style="flex:1;min-width:0;">${rightCol}</div>
                    </div>
                `;
            } else if (leader) {
                // clanless viewer: single line for who's on top
                body = `
                    <div style="font-size:11px;margin-top:4px;">
                        👑 ${leader.tag ? `[${escapeHtml(leader.tag)}] ` : ""}<b>${escapeHtml(leader.name)}</b>
                        <span style="color:#00ff66;">${leader.eventScore >= 0 ? "+" : ""}${leader.eventScore}</span>
                    </div>
                `;
            }
        } else if (phase === "ended") {
            if (clan) {
                const score = computeClanEventScore(clan);
                const scoreColor = score >= 0 ? "#00ff66" : "#ff6b6b";
                const myRank = standings.findIndex(c => c.id === clan.id) + 1;
                body = `
                    <div style="font-size:11px;margin-top:4px;">
                        Final <span style="color:${scoreColor};font-weight:bold;">${score >= 0 ? "+" : ""}${score}</span>
                        ${myRank > 0 ? ` · #${myRank} of ${standings.length}` : ""}
                    </div>
                `;
            }
        }

        return `<div style="border:1px solid ${gold}55;background:${gold}11;border-radius:8px;padding:8px 10px;margin-bottom:8px;">${header}${body}</div>`;
    }

    // ---------- Clans (Stage 1: create / browse / request / approve) ----------

    let myClan = null;          // the clan doc this player belongs to, or null
    let clanDirectory = [];     // lightweight list of all clans for browsing
    let clanLoaded = false;
    let clanLoadedForAccount = null; // which account the above was loaded for

    // reads events/current.maxMembers so the cap can be changed live
    const DEFAULT_CLAN_MAX_MEMBERS = 5;
    function clanMaxMembers() {
        const n = eventConfig?.maxMembers;
        return (typeof n === "number" && n > 0 && n <= 50) ? n : DEFAULT_CLAN_MAX_MEMBERS;
    }

    function myUserId() { return lastKnownPlayerData?.Id ?? null; }

    // plain in-game name (first line, TMP tags stripped, [TAG] prefix removed).
    // used to seed Name Forge, not the leaderboard display name.
    function myGameNamePlain() {
        const raw = String(lastKnownPlayerData?.Nickname ?? "");
        if (!raw) return "";
        const firstLine = raw.split(/<br\s*\/?\s*>/i)[0];
        let plain = firstLine.replace(/<[^>]*>/g, "").trim();
        plain = plain.replace(/^\[[^\]]{1,6}\]\s*/, "");
        return plain;
    }

    function myName() {
        return cachedDisplayNames.get(myUserId()) || cleanName(lastKnownPlayerData?.Nickname) || "Unknown";
    }

    function canManageRequests(role) {
        return rolePerm(role, "approve");
    }

    // live clan-doc listener. attach while Clan tab is open, detach on close.
    // callback must render from the snapshot, no refetching, or costs triple.
    let _clanUnsub = null;
    let _clanListenerId = null;
    let _clanAttaching = false; // v13.6: guard against re-entry during init await

    // v13.6: sanitize user-editable style fields at the trust boundary.
    // a modified client could push HTML-shaped strings into tagStyle.color
    // and land stored XSS in every member's browser via the snapshot listener.
    function sanitizeClanDoc(clan) {
        if (!clan) return clan;
        const hexOk = v => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
        if (clan.tagStyle && typeof clan.tagStyle === "object") {
            const st = clan.tagStyle;
            const cleanMode = (["none", "solid", "gradient"].includes(st.mode)) ? st.mode : null;
            const cleanPalette = (typeof st.paletteKey === "string" && st.paletteKey.length < 40 && /^[A-Za-z0-9_-]+$/.test(st.paletteKey)) ? st.paletteKey : null;
            clan.tagStyle = {
                mode: cleanMode,
                color: hexOk(st.color) ? st.color : null,
                gradientStart: hexOk(st.gradientStart) ? st.gradientStart : null,
                gradientEnd: hexOk(st.gradientEnd) ? st.gradientEnd : null,
                bracketColor: hexOk(st.bracketColor) ? st.bracketColor : null,
                paletteKey: cleanPalette,
                bold: !!st.bold,
                italic: !!st.italic,
                waveOn: !!st.waveOn,
                waveAmp: (typeof st.waveAmp === "number" && st.waveAmp >= 0 && st.waveAmp <= 60) ? st.waveAmp : 8,
                rotateDeg: (typeof st.rotateDeg === "number" && st.rotateDeg >= -45 && st.rotateDeg <= 45) ? st.rotateDeg : 0,
            };
        }
        return clan;
    }

    async function attachClanListener() {
        if (!myClan) return;
        if (_clanUnsub && _clanListenerId === myClan.id) return;
        // v13.6: without this reentry guard two rapid calls both await init
        // then both call onSnapshot, leaking the first listener.
        if (_clanAttaching) return;
        _clanAttaching = true;
        try {
            detachClanListener();
            const fb = await initFirebase();
            if (!fb || !myClan) return;
            const clanId = myClan.id;
            _clanListenerId = clanId;
            _clanUnsub = fb.onSnapshot(
                fb.doc(fb.db, "clans", clanId),
                (snap) => {
                    const uid = myUserId();
                    // doc gone (disband) or we're off the roster (left/kicked).
                    // this is also how a kicked player sees it happen live.
                    const stillMember = snap.exists()
                        && ((snap.data().members ?? []).some(m => m.userId === uid));
                    if (!stillMember) {
                        detachClanListener();
                        myClan = null;
                        clanLoaded = false;
                        refreshClanViewIfOpen();
                        return;
                    }
                    myClan = sanitizeClanDoc({ id: snap.id, ...snap.data() });
                    refreshClanViewIfOpen();
                    // v13.6: repaint main stats too so Clash mini-bar updates live
                    if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
                },
                (err) => {
                    // v13.6: without onError, revoked perms froze the UI silently
                    console.warn("[RG HUD] Clan listener error:", err);
                    showError("Clan updates disconnected — reopen the Clan tab to refresh");
                    detachClanListener();
                }
            );
        } catch (e) {
            console.warn("[RG HUD] Clan listener attach failed:", e);
            _clanListenerId = null;
        } finally {
            _clanAttaching = false;
        }
    }
    function detachClanListener() {
        if (_clanUnsub) {
            try { _clanUnsub(); } catch (e) {}
            _clanUnsub = null;
        }
        _clanListenerId = null;
    }

    async function loadClanData(force = false) {
        const uid = myUserId();
        if (!uid) return;

        // new account since last load, reset
        if (clanLoadedForAccount !== uid) {
            force = true;
            myClan = null;
            clanDirectory = [];
            clanLoaded = false;
        }

        if (clanLoaded && !force) return;
        const fb = await initFirebase();
        if (!fb) return;

        try {
            const dirSnap = await fb.getDoc(fb.doc(fb.db, "clans_directory", "index"));
            clanDirectory = dirSnap.exists() ? (dirSnap.data().clans ?? []) : [];

            myClan = null;
            const mine = clanDirectory.find(c => (c.memberIds ?? []).includes(uid));
            if (mine) {
                const clanSnap = await fb.getDoc(fb.doc(fb.db, "clans", mine.id));
                if (clanSnap.exists()) myClan = sanitizeClanDoc({ id: mine.id, ...clanSnap.data() });
            }
            clanLoaded = true;
            clanLoadedForAccount = uid;
        } catch (e) {
            console.warn("[RG HUD] Clan load failed:", e);
        }
    }

    // COST: refreshDirectory reads EVERY clan doc + 1 write. fine for structural
    // changes (create/join/kick/leave). routine per-match MMR ticks go through
    // refreshDirectoryThrottled instead.

    // zero-read patch of my own entry in the in-memory directory
    function patchMyClanInDirectory() {
        if (!myClan) return;
        const entry = clanDirectory.find(c => c.id === myClan.id);
        if (!entry) return;
        entry.name = myClan.name;
        entry.tag = myClan.tag ?? "";
        entry.memberCount = (myClan.members ?? []).length;
        entry.memberIds = (myClan.members ?? []).map(m => m.userId);
        entry.totalMMR = myClan.totalMMR ?? 0;
        entry.eventScore = computeClanEventScore(myClan);
        entry.eventId = myClan.eventId ?? null;
        applyTitle(); // clan-lead flip
    }

    // throttled rebuild for routine MMR updates. structural changes still call
    // refreshDirectory directly. my own HUD stays live via patchMyClanInDirectory.
    let lastDirRefreshAt = 0;
    const DIR_REFRESH_THROTTLE_MS = 3 * 60 * 1000;

    async function refreshDirectoryThrottled(fb) {
        patchMyClanInDirectory();
        const now = Date.now();
        if (now - lastDirRefreshAt < DIR_REFRESH_THROTTLE_MS) return;
        lastDirRefreshAt = now;
        await refreshDirectory(fb);
    }


    function renderClanTagPanel() {
        const body = document.getElementById("rgClanTagBody");
        if (!body || !myClan) return;
        const isLeader = myClan.leaderId === myUserId();
        // roles with tagStyle perm see the full editor; others see preview + opt-in
        const canStyle = rolePerm(myClanRole(), "tagStyle");
        const st = myClan.tagStyle || {};
        const tagText = String(myClan.tag || "").trim();

        // working copy, live edits don't commit until Save
        const work = {
            mode: st.mode || (st.color ? "solid" : Array.isArray(st.stops) || st.paletteKey ? "gradient" : "none"),
            color: st.color || "#00bfff",
            gradientStart: st.gradientStart || "#00bfff",
            gradientEnd: st.gradientEnd || "#e94fff",
            paletteKey: st.paletteKey || null,   // null = custom start/end
            bracketColor: st.bracketColor || null, // null = brackets follow main style
            bold: !!st.bold,
            italic: !!st.italic,
            waveOn: !!st.waveOn,
            waveAmp: st.waveAmp ?? 8,
            rotateDeg: st.rotateDeg ?? 0,
        };

        function activeStops() {
            if (work.paletteKey) {
                const p = CLAN_TAG_PALETTES.find(x => x.key === work.paletteKey);
                if (p) return p.stops;
            }
            return [work.gradientStart, work.gradientEnd];
        }

        // when bracketColor is set, the gradient runs over just the letters
        // so the blend isn't broken by contrast-colored brackets
        function buildPreviewHtml() {
            if (!tagText) return '<span style="color:#888;font-style:italic;font-size:14px;">(clan has no tag set)</span>';
            const escCh = ch => ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
            const tagChars = [...tagText];
            const bracketColor = /^#[0-9a-fA-F]{6}$/.test(work.bracketColor || "") ? work.bracketColor : null;
            const stops = work.mode === "gradient" ? activeStops() : null;

            // wave alternates per char, static rotate is uniform
            const rotFor = wi => work.waveOn ? (wi % 2 === 0 ? work.waveAmp : -work.waveAmp)
                : (work.rotateDeg && !work.waveOn ? work.rotateDeg : 0);
            const spanFor = (ch, color, wi) => {
                const rot = rotFor(wi);
                const tf = rot ? "display:inline-block;transform:rotate(" + rot + "deg);" : "";
                const co = color ? "color:" + color + ";" : "";
                return '<span style="' + co + tf + '">' + escCh(ch) + '</span>';
            };

            // letter color at position i / tagChars.length
            const letterColor = (i) => {
                if (stops) {
                    const giMax = bracketColor ? Math.max(0, tagChars.length - 1) : tagChars.length + 1;
                    const gi = bracketColor ? i : i + 1;
                    const t = giMax === 0 ? 0 : gi / giMax;
                    return _sampleStops(stops, t);
                }
                if (work.mode === "solid") return work.color;
                return null;
            };
            // bracket color: bracketColor if set, else defer to mode
            const bracketC = bracketColor
                ? bracketColor
                : stops
                    ? _sampleStops(stops, 0) // start of gradient for opening
                    : work.mode === "solid" ? work.color : null;
            const bracketCEnd = bracketColor
                ? bracketColor
                : stops
                    ? _sampleStops(stops, 1)
                    : work.mode === "solid" ? work.color : null;

            let wi = 0;
            let content = spanFor("[", bracketC, wi++);
            for (let i = 0; i < tagChars.length; i++) {
                content += spanFor(tagChars[i], letterColor(i), wi++);
            }
            content += spanFor("]", bracketCEnd, wi++);

            const wrapStyle = "font-size:22px;font-weight:" + (work.bold ? "700" : "400") + ";font-style:" + (work.italic ? "italic" : "normal") + ";";
            return '<span style="' + wrapStyle + '">' + content + '</span>';
        }

        function updatePreview() {
            const el = document.getElementById("rgTagPreviewInner");
            if (el) el.innerHTML = buildPreviewHtml();
        }

        // ---- Build panel HTML ----
        let html = '';

        // big preview box (Forge style)
        html += '<div style="background:radial-gradient(120% 140% at 50% 0%, #101a3a 0%, #070a16 70%);border:1px solid #00bfff44;border-radius:10px;padding:16px;text-align:center;min-height:60px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;">'
            + '<span id="rgTagPreviewInner">' + buildPreviewHtml() + '</span></div>';

        if (canStyle && tagText) {
            // mode selector
            html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:6px 0 4px;">STYLE MODE</div>';
            html += '<div style="display:flex;gap:4px;">';
            for (const m of ["none","solid","gradient"]) {
                const active = work.mode === m;
                html += '<button class="rgBtn rgTagMode" data-mode="' + m + '" style="flex:1;padding:5px;font-size:11px;'
                    + (active ? 'background:#00bfff33;border:1px solid #00bfff;color:#00bfff;' : '') + '">'
                    + m.charAt(0).toUpperCase() + m.slice(1) + '</button>';
            }
            html += '</div>';

            // solid color row
            html += '<div id="rgTagSolidRow" style="margin-top:8px;display:' + (work.mode === "solid" ? "flex" : "none") + ';gap:8px;align-items:center;font-size:11px;">'
                + 'Color: <input type="color" id="rgTagColor" value="' + work.color + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '<span id="rgTagColorHex" style="opacity:.7;font-family:monospace;">' + work.color + '</span>'
                + '</div>';

            // gradient section: palettes + custom endpoints + preview bar
            html += '<div id="rgTagGradientRow" style="margin-top:8px;display:' + (work.mode === "gradient" ? "block" : "none") + ';font-size:11px;">';
            html += '<div style="opacity:.7;margin-bottom:4px;">Palettes</div>';
            html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
            for (const p of CLAN_TAG_PALETTES) {
                const active = work.paletteKey === p.key;
                html += '<button class="rgBtn rgTagPalette" data-key="' + p.key + '" style="padding:3px 8px;font-size:11px;'
                    + (active ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">'
                    + p.label + '</button>';
            }
            html += '<button class="rgBtn rgTagPalette" data-key="__custom" style="padding:3px 8px;font-size:11px;'
                + (!work.paletteKey ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">Custom</button>';
            html += '</div>';
            html += '<div id="rgTagCustomRow" style="margin-top:6px;display:' + (work.paletteKey ? "none" : "flex") + ';gap:8px;align-items:center;flex-wrap:wrap;">'
                + 'Start: <input type="color" id="rgTagGradStart" value="' + work.gradientStart + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '&rarr; End: <input type="color" id="rgTagGradEnd" value="' + work.gradientEnd + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '</div>';
            const barStops = activeStops();
            html += '<div id="rgTagGradientBar" style="margin-top:6px;height:6px;border-radius:3px;background:linear-gradient(90deg, ' + barStops.join(", ") + ');"></div>';
            html += '</div>';

            // bold + italic
            html += '<div style="margin-top:10px;display:flex;gap:16px;font-size:11px;">'
                + '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="rgTagBold"' + (work.bold ? " checked" : "") + '> <b>Bold</b></label>'
                + '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="rgTagItalic"' + (work.italic ? " checked" : "") + '> <i>Italic</i></label>'
                + '</div>';

            // cleared bracket color -> brackets follow the main style
            html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:10px 0 4px;">BRACKETS</div>';
            html += '<div style="display:flex;gap:8px;align-items:center;font-size:11px;">'
                + 'Color: <input type="color" id="rgTagBracketColor" value="' + (work.bracketColor || "#ffffff") + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '<button id="rgTagBracketMatch" class="rgBtn" style="padding:3px 8px;font-size:10px;'
                + (!work.bracketColor ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">Match tag</button>'
                + '<span style="opacity:.6;font-size:10px;">' + (work.bracketColor ? work.bracketColor : "matches") + '</span>'
                + '</div>';

            // wave overrides static rotate
            html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:10px 0 4px;">EFFECTS</div>';
            html += '<label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;">'
                + '<input type="checkbox" id="rgTagWave"' + (work.waveOn ? " checked" : "") + '> Wave'
                + ' <span style="opacity:.6;margin-left:4px;">(alternates ±<span id="rgTagWaveAmpLbl">' + work.waveAmp + '</span>°)</span>'
                + '</label>';
            html += '<div id="rgTagWaveRow" style="margin-top:4px;display:' + (work.waveOn ? "flex" : "none") + ';gap:8px;align-items:center;font-size:11px;">'
                + 'Amp: <input type="range" id="rgTagWaveAmp" min="0" max="30" value="' + work.waveAmp + '" style="flex:1;">'
                + '</div>';
            html += '<div id="rgTagRotateRow" style="margin-top:6px;display:' + (work.waveOn ? "none" : "flex") + ';gap:8px;align-items:center;font-size:11px;">'
                + 'Rotate: <input type="range" id="rgTagRotate" min="-45" max="45" value="' + work.rotateDeg + '" style="flex:1;">'
                + '<span id="rgTagRotateLbl" style="width:32px;opacity:.7;">' + work.rotateDeg + '°</span>'
                + '</div>';

            html += '<button id="rgTagSave" class="rgBtn" style="width:100%;margin-top:10px;">Save Tag Style</button>';
        } else if (!canStyle && !tagText) {
            html += '<div style="font-size:11px;color:#888;text-align:center;margin-top:4px;">Leader hasn\'t set a tag yet.</div>';
        }

        // opt-in (all members)
        if (tagText) {
            html += '<hr style="border:none;border-top:1px solid #00bfff22;margin:10px 0 8px;">';
            html += '<label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;">'
                + '<input type="checkbox" id="rgUseTag"' + (useClanTagPref() ? " checked" : "") + '>'
                + ' Prepend clan tag to my in-game name</label>';
        }

        body.innerHTML = html;

        // ---- Wire live-update handlers ----
        if (canStyle && tagText) {
            // mode buttons
            for (const btn of document.querySelectorAll(".rgTagMode")) {
                btn.onclick = () => {
                    work.mode = btn.getAttribute("data-mode");
                    document.getElementById("rgTagSolidRow").style.display = work.mode === "solid" ? "flex" : "none";
                    document.getElementById("rgTagGradientRow").style.display = work.mode === "gradient" ? "block" : "none";
                    document.querySelectorAll(".rgTagMode").forEach(b => {
                        const active = b === btn;
                        b.style.background = active ? "#00bfff33" : "";
                        b.style.border = active ? "1px solid #00bfff" : "";
                        b.style.color = active ? "#00bfff" : "";
                    });
                    updatePreview();
                };
            }
            // palette chips. "Custom" returns to user start/end
            for (const btn of document.querySelectorAll(".rgTagPalette")) {
                btn.onclick = () => {
                    const key = btn.getAttribute("data-key");
                    work.paletteKey = key === "__custom" ? null : key;
                    document.querySelectorAll(".rgTagPalette").forEach(b => {
                        const active = (b.getAttribute("data-key") === (work.paletteKey || "__custom"));
                        b.style.background = active ? "#00bfff33" : "";
                        b.style.border = active ? "1px solid #00bfff" : "";
                    });
                    document.getElementById("rgTagCustomRow").style.display = work.paletteKey ? "none" : "flex";
                    const bar = document.getElementById("rgTagGradientBar");
                    if (bar) bar.style.background = "linear-gradient(90deg, " + activeStops().join(", ") + ")";
                    updatePreview();
                };
            }
            const wireInput = (id, key, extra) => {
                const el = document.getElementById(id);
                if (el) el.oninput = () => { work[key] = el.value; if (extra) extra(); updatePreview(); };
            };
            wireInput("rgTagColor", "color", () => {
                const hex = document.getElementById("rgTagColorHex");
                if (hex) hex.textContent = work.color;
            });
            const refreshBar = () => {
                const bar = document.getElementById("rgTagGradientBar");
                if (bar) bar.style.background = "linear-gradient(90deg, " + activeStops().join(", ") + ")";
            };
            wireInput("rgTagGradStart", "gradientStart", refreshBar);
            wireInput("rgTagGradEnd", "gradientEnd", refreshBar);
            const wireCheck = (id, key) => {
                const el = document.getElementById(id);
                if (el) el.onchange = () => { work[key] = el.checked; updatePreview(); };
            };
            wireCheck("rgTagBold", "bold");
            wireCheck("rgTagItalic", "italic");

            // "Match tag" clears bracket color so brackets rejoin main style
            const bracketColorEl = document.getElementById("rgTagBracketColor");
            const bracketMatchBtn = document.getElementById("rgTagBracketMatch");
            const bracketHexLbl = () => bracketMatchBtn && bracketMatchBtn.nextElementSibling;
            if (bracketColorEl) bracketColorEl.oninput = () => {
                work.bracketColor = bracketColorEl.value;
                if (bracketMatchBtn) {
                    bracketMatchBtn.style.background = "";
                    bracketMatchBtn.style.border = "";
                }
                const lbl = bracketHexLbl();
                if (lbl) lbl.textContent = work.bracketColor;
                updatePreview();
            };
            if (bracketMatchBtn) bracketMatchBtn.onclick = () => {
                work.bracketColor = null;
                bracketMatchBtn.style.background = "#00bfff33";
                bracketMatchBtn.style.border = "1px solid #00bfff";
                const lbl = bracketHexLbl();
                if (lbl) lbl.textContent = "matches";
                updatePreview();
            };
            const waveEl = document.getElementById("rgTagWave");
            if (waveEl) waveEl.onchange = () => {
                work.waveOn = waveEl.checked;
                document.getElementById("rgTagWaveRow").style.display = work.waveOn ? "flex" : "none";
                document.getElementById("rgTagRotateRow").style.display = work.waveOn ? "none" : "flex";
                updatePreview();
            };
            const waveAmpEl = document.getElementById("rgTagWaveAmp");
            if (waveAmpEl) waveAmpEl.oninput = () => {
                work.waveAmp = Number(waveAmpEl.value);
                const lbl = document.getElementById("rgTagWaveAmpLbl");
                if (lbl) lbl.textContent = work.waveAmp;
                updatePreview();
            };
            const rotEl = document.getElementById("rgTagRotate");
            if (rotEl) rotEl.oninput = () => {
                work.rotateDeg = Number(rotEl.value);
                const lbl = document.getElementById("rgTagRotateLbl");
                if (lbl) lbl.textContent = work.rotateDeg + "°";
                updatePreview();
            };

            document.getElementById("rgTagSave").onclick = async () => {
                const newStyle = {
                    mode: work.mode,
                    color: work.color,
                    gradientStart: work.gradientStart,
                    gradientEnd: work.gradientEnd,
                    paletteKey: work.paletteKey,
                    bracketColor: work.bracketColor,
                    bold: work.bold,
                    italic: work.italic,
                    waveOn: work.waveOn,
                    waveAmp: work.waveAmp,
                    rotateDeg: work.rotateDeg,
                };
                try {
                    const fb = await initFirebase();
                    if (!fb) return;
                    await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { tagStyle: newStyle }, { merge: true });
                    myClan.tagStyle = newStyle;
                    // inline confirm, toast is easy to miss when scrolled deep
                    const saveBtn = document.getElementById("rgTagSave");
                    if (saveBtn) {
                        saveBtn.textContent = "✓ Saved for the clan!";
                        saveBtn.style.borderColor = "#00ff88";
                        saveBtn.style.color = "#00ff88";
                        setTimeout(() => {
                            saveBtn.textContent = "Save Tag Style";
                            saveBtn.style.borderColor = "";
                            saveBtn.style.color = "";
                        }, 1800);
                    }
                    showToast("Saved! Open 🎨 Forge and hit Apply to refresh YOUR name -- members do the same on theirs.");
                } catch (e) { console.error("[RG HUD] Save tag style failed:", e); showToast("Save failed."); }
            };
        }

        // opt-in handler
        const useTagCb = document.getElementById("rgUseTag");
        if (useTagCb) {
            useTagCb.onchange = () => {
                setUseClanTagPref(useTagCb.checked);
                // prefix only reaches the in-game name after Apply in Name Forge
                showToast(useTagCb.checked
                    ? "Tag armed! Open 🎨 Name Forge and hit Apply to update your name."
                    : "Tag prefix off -- hit Apply in 🎨 Name Forge to update your name.");
                if (typeof RGNF !== "undefined" && RGNF.refresh) RGNF.refresh();
            };
        }
    }

    async function refreshDirectory(fb) {
        try {
            const snap = await fb.getDocs(fb.collection(fb.db, "clans"));
            const clans = [];
            snap.forEach(docSnap => {
                const d = docSnap.data();
                clans.push({
                    id: docSnap.id,
                    name: d.name,
                    tag: d.tag ?? "",
                    tagStyle: d.tagStyle || null,
                    memberCount: (d.members ?? []).length,
                    memberIds: (d.members ?? []).map(m => m.userId),
                    totalMMR: d.totalMMR ?? 0,
                    // 0 if their baseline is stale/absent
                    eventScore: computeClanEventScore({ ...d, id: docSnap.id }),
                    eventId: d.eventId ?? null,
                });
            });
            await fb.setDoc(fb.doc(fb.db, "clans_directory", "index"), { clans });
            clanDirectory = clans;
        } catch (e) {
            console.warn("[RG HUD] Directory refresh failed:", e);
        }
        // repaint title in case standings flipped clan-lead status
        applyTitle();
    }

    // sum of 3v3+2v2+1v1 displayRatings (no casual)
    function myRankedMMR() {
        const g = lastKnownPlayerData?.ModesGlicko;
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1"];
        return modes.reduce((s, m) => s + (typeof g?.[m]?.displayRating === "number" ? g[m].displayRating : 0), 0);
    }

    async function createClan(name, tag) {
        const fb = await initFirebase();
        if (!fb) return;
        const uid = myUserId();
        if (!uid) return;

        if (!eventPerm("allowClanCreate")) {
            showToast("New clans can\'t be created during this event.");
            return;
        }

        // best-effort uniqueness check
        if (clanDirectory.some(c => c.name.toLowerCase() === name.toLowerCase())) {
            showToast("A clan with that name already exists.");
            return;
        }

        try {
            const clan = {
                name,
                tag: tag || "",
                tagStyle: null,
                leaderId: uid,
                members: [{ userId: uid, name: myName(), role: "leader" }],
                joinRequests: [],
                totalMMR: myRankedMMR(),
                createdAt: new Date().toISOString(),
            };
            const ref = await fb.addDoc(fb.collection(fb.db, "clans"), clan);
            dbg(`Clan created: name="${name}" tag="${tag || ""}" id=${ref.id}`);
            myClan = { id: ref.id, ...clan };
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            pushError(e, "createClan");
            console.error("[RG HUD] Create clan failed:", e);
            showToast("Couldn't create clan (see console).");
        }
    }

    async function requestJoin(clanId) {
        const fb = await initFirebase();
        if (!fb) return;
        const uid = myUserId();
        if (!uid) return;

        if (!eventPerm("allowJoin")) {
            showToast("Clan joins are locked during this event.");
            return;
        }

        try {
            const clanSnap = await fb.getDoc(fb.doc(fb.db, "clans", clanId));
            if (!clanSnap.exists()) return;
            const clan = clanSnap.data();

            if ((clan.members ?? []).length >= clanMaxMembers()) {
                showToast("That clan is full.");
                return;
            }
            if ((clan.joinRequests ?? []).some(r => r.userId === uid)) {
                showToast("You already requested to join.");
                return;
            }
            const joinRequests = [...(clan.joinRequests ?? []), { userId: uid, name: myName() }];
            await fb.setDoc(fb.doc(fb.db, "clans", clanId), { joinRequests }, { merge: true });
            dbg(`Join request sent to clan ${clanId}`);
            showToast("Join request sent!");
            renderClanView();
        } catch (e) {
            pushError(e, "requestJoin");
            console.error("[RG HUD] Request join failed:", e);
            showToast("Couldn't send join request — see console.");
        }
    }

    async function approveRequest(userId, approve) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;

        // denies are always allowed, they don't grow the roster
        if (approve && !eventPerm("allowApprove")) {
            showToast("Approvals are locked during this event.");
            return;
        }
        if (approve && !rolePerm(myClanRole(), "approve")) {
            showToast("Your role can't approve join requests.");
            return;
        }

        try {
            const req = (myClan.joinRequests ?? []).find(r => r.userId === userId);
            const joinRequests = (myClan.joinRequests ?? []).filter(r => r.userId !== userId);
            let members = myClan.members ?? [];

            if (approve && req && members.length < clanMaxMembers()
                && !members.some(m => m.userId === userId)) {
                members = [...members, { userId: req.userId, name: req.name, role: "member" }];
            }

            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { joinRequests, members }, { merge: true });
            dbg(`Join request ${approve ? "approved" : "denied"} for ${userId}`);
            myClan.joinRequests = joinRequests;
            myClan.members = members;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            pushError(e, "approveRequest");
            console.error("[RG HUD] Approve request failed:", e);
            showToast(approve ? "Couldn't approve — see console." : "Couldn't deny — see console.");
        }
    }

    async function kickMember(userId, message) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();

        if (!eventPerm("allowKick")) {
            showToast("Kicking is locked during this event.");
            return;
        }

        try {
            const target = (myClan.members ?? []).find(m => m.userId === userId);
            if (!target || target.role === "leader") return;
            // must have perm AND outrank the target (elder can't kick elder)
            const me = (myClan.members ?? []).find(m => m.userId === myUid);
            if (!me || !rolePerm(me.role, "kick")) return;
            if ((ROLE_RANK[target.role] ?? 0) >= (ROLE_RANK[me.role] ?? 0)) return;

            const members = (myClan.members ?? []).filter(m => m.userId !== userId);
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            dbg(`Clan kick: ${userId} removed, msgLen=${(message ?? "").length}`);
            myClan.members = members;

            // one-time notice picked up + cleared by the kicked player's HUD
            const notice = {
                type: "kicked",
                clanName: myClan.name,
                message: (message ?? "").slice(0, 200),
                at: new Date().toISOString(),
            };
            await fb.setDoc(fb.doc(fb.db, "clan_notices", userId), notice);

            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            pushError(e, "kickMember");
            console.error("[RG HUD] Kick failed:", e);
            showToast("Couldn't kick member (see console).");
        }
    }

    // show + clear any pending kick notice
    async function checkClanNotices() {
        const fb = await initFirebase();
        if (!fb) return;
        const uid = myUserId();
        if (!uid) return;
        try {
            const ref = fb.doc(fb.db, "clan_notices", uid);
            const snap = await fb.getDoc(ref);
            if (snap.exists()) {
                const n = snap.data();
                if (n.type === "kicked") {
                    const extra = n.message ? `  Message: "${n.message}"` : "";
                    showDialog({
                        message: `You were removed from clan "${n.clanName}".${extra}`,
                        okLabel: "OK",
                        cancelLabel: "Dismiss",
                    });
                }
                await fb.deleteDoc(ref);
            }
        } catch (e) {
            // notices are best-effort
        }
    }

    // ---------- Role management ----------
    // leader > coleader > elder > member. multiple coleaders/elders allowed.
    // gating enforced client-side (honor system).

    const ROLE_RANK = { leader: 3, coleader: 2, elder: 1, member: 0 };

    // can `actorRole` set `targetCurrentRole` to `newRole`?
    function canSetRole(actorRole, targetCurrentRole, newRole) {
        const a = ROLE_RANK[actorRole] ?? -1;
        if (!rolePerm(actorRole, "roleChange")) return false;
        // can't touch someone at/above your own rank
        if ((ROLE_RANK[targetCurrentRole] ?? 0) >= a) return false;
        // can't promote someone to at/above your own rank
        if ((ROLE_RANK[newRole] ?? 0) >= a) return false;
        // leader can only be assigned via transferLeadership
        if (newRole === "leader") return false;
        return true;
    }

    async function setMemberRole(userId, newRole) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();
        const me = (myClan.members ?? []).find(m => m.userId === myUid);
        const target = (myClan.members ?? []).find(m => m.userId === userId);
        if (!me || !target) return;

        // frozen by default during events, role changes muddy the contribution audit
        if (!eventPerm("allowRoleChange")) {
            showToast("Role changes are locked during this event.");
            return;
        }

        if (!canSetRole(me.role, target.role, newRole)) {
            showToast("You can't change that member's role.");
            return;
        }

        try {
            const members = (myClan.members ?? []).map(m =>
                m.userId === userId ? { ...m, role: newRole } : m
            );
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            dbg(`Clan role change: ${userId} ${target.role} -> ${newRole}`);
            myClan.members = members;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            pushError(e, "setMemberRole");
            console.error("[RG HUD] Set role failed:", e);
            showToast("Couldn't change role (see console).");
        }
    }

    async function editClan(newName, newTag) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        if (!rolePerm(myClanRole(), "editClanInfo")) return;

        // frozen during events so leaderboards don't see mid-event rebrands
        if (!eventPerm("allowRenameClan")) {
            showToast("Clan renames are locked during this event.");
            return;
        }

        // uniqueness, ignore our own clan
        const nameClash = clanDirectory.some(c => c.id !== myClan.id && (c.name ?? "").toLowerCase() === newName.toLowerCase());
        const tagClash = clanDirectory.some(c => c.id !== myClan.id && (c.tag ?? "").toLowerCase() === newTag.toLowerCase());
        if (nameClash) { showToast("A clan with that name already exists."); return; }
        if (tagClash) { showToast("That tag is already taken."); return; }

        try {
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { name: newName, tag: newTag }, { merge: true });
            dbg(`Clan edited: name="${newName}" tag="${newTag}"`);
            myClan.name = newName;
            myClan.tag = newTag;
            await refreshDirectory(fb);
            showToast("Clan updated! Tag refreshes on members' next match.");
            renderClanView();
        } catch (e) {
            pushError(e, "editClan");
            console.error("[RG HUD] Edit clan failed:", e);
            showToast("Couldn't update clan (see console).");
        }
    }

    function showEditClanForm() {
        const view = document.getElementById("rgClanView");
        view.innerHTML = `
            <b>Edit Clan</b>
            <div style="margin-top:8px;">
                <input type="text" id="rgEditName" maxlength="24" value="${escapeHtml(myClan.name ?? "")}"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;margin-bottom:6px;user-select:text;">
                <input type="text" id="rgEditTag" maxlength="4" value="${escapeHtml(myClan.tag ?? "")}"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;user-select:text;text-transform:uppercase;"
                    oninput="this.value=this.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,4);">
                <div id="rgEditErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
                <div style="display:flex;gap:6px;">
                    <button id="rgEditGo" class="rgBtn" style="flex:1;">Save</button>
                    <button id="rgEditCancel" class="rgBtn" style="flex:1;">Cancel</button>
                </div>
            </div>`;

        probeInput(document.getElementById("rgEditName"), "rgEditName");
        probeInput(document.getElementById("rgEditTag"), "rgEditTag");
        const errEl = document.getElementById("rgEditErr");
        document.getElementById("rgEditGo").onclick = () => {
            const name = document.getElementById("rgEditName").value.trim();
            const tag = sanitizeClanTag(document.getElementById("rgEditTag").value);
            if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
            if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag: 2-4 letters, no numbers or symbols."; return; }
            if (containsProfanity(name) || containsEmoji(name)) { errEl.textContent = "That name isn't allowed."; return; }
            if (containsProfanity(tag) || containsEmoji(tag)) { errEl.textContent = "That tag isn't allowed."; return; }
            editClan(name, tag);
        };
        document.getElementById("rgEditCancel").onclick = renderClanView;
    }

    async function transferLeadership(userId) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();
        if (myClan.leaderId !== myUid) return;
        if (!rolePerm(myClanRole(), "transfer")) {
            showToast("Leadership transfers are currently disabled.");
            return;
        }

        if (!eventPerm("allowTransfer")) {
            showToast("Leadership transfers are locked during this event.");
            return;
        }

        try {
            const members = (myClan.members ?? []).map(m => {
                if (m.userId === userId) return { ...m, role: "leader" };
                if (m.userId === myUid) return { ...m, role: "coleader" };
                return m;
            });
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members, leaderId: userId }, { merge: true });
            dbg(`Clan leadership transferred to ${userId}`);
            myClan.members = members;
            myClan.leaderId = userId;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            pushError(e, "transferLeadership");
            console.error("[RG HUD] Transfer leadership failed:", e);
            showToast("Couldn't transfer leadership (see console).");
        }
    }


    // ---------- Clan tag styling ----------
    // leader owns clan.tagStyle. members opt in via localStorage so the clan
    // doc doesn't balloon. getClanTagPrefix() returns TMP markup used at Apply.

    const CLAN_TAG_OPTIN_KEY = "rgHudUseClanTag";

    function useClanTagPref() {
        try { return localStorage.getItem(CLAN_TAG_OPTIN_KEY) === "1"; } catch { return false; }
    }
    function setUseClanTagPref(on) {
        try { localStorage.setItem(CLAN_TAG_OPTIN_KEY, on ? "1" : "0"); } catch {}
    }

    function _interpHex(a, b, t) {
        const ar = parseInt(a.slice(1,3),16), ag = parseInt(a.slice(3,5),16), ab_ = parseInt(a.slice(5,7),16);
        const br = parseInt(b.slice(1,3),16), bg = parseInt(b.slice(3,5),16), bb = parseInt(b.slice(5,7),16);
        const r = Math.round(ar + (br-ar)*t), g = Math.round(ag + (bg-ag)*t), bl = Math.round(ab_ + (bb-ab_)*t);
        return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + bl.toString(16).padStart(2,'0');
    }

    // same math Name Forge uses so tag/name gradients look the same
    function _sampleStops(stops, t) {
        if (!stops || stops.length === 0) return "#ffffff";
        if (stops.length === 1) return stops[0];
        const scaled = t * (stops.length - 1);
        const i = Math.min(Math.floor(scaled), stops.length - 2);
        return _interpHex(stops[i], stops[i + 1], scaled - i);
    }

    // mirrors Name Forge palettes
    const CLAN_TAG_PALETTES = [
        { key: 'fire',    label: '🔥 Fire',    stops: ['#FF4D00', '#FFB800', '#FF0000'] },
        { key: 'ocean',   label: '🌊 Ocean',   stops: ['#00FFFF', '#00CFFF'] }, // exact [KING] shimmer: K,I,N,G sample to #00FFFF,#00EFFF,#00DFFF,#00CFFF
        { key: 'rainbow', label: '🌈 Rainbow', stops: ['#FF0000', '#FFFF00', '#00FF00', '#00BFFF', '#8B00FF'] },
        { key: 'sunset',  label: '🌇 Sunset',  stops: ['#FF6B6B', '#FFB347', '#8E44AD'] },
        { key: 'toxic',   label: '☢️ Toxic',   stops: ['#39FF14', '#CCFF00', '#00FF9F'] },
        { key: 'ice',     label: '❄️ Ice',     stops: ['#E0FFFF', '#7DD3FC', '#2563EB'] },
    ];

    // palette stops if picked, else user-picked endpoints. null if not gradient.
    function _tagStops(st) {
        if (!st) return null;
        if (st.paletteKey) {
            const p = CLAN_TAG_PALETTES.find(x => x.key === st.paletteKey);
            if (p) return p.stops;
        }
        if (Array.isArray(st.stops) && st.stops.length >= 2) return st.stops;
        if (/^#[0-9a-fA-F]{6}$/.test(st.gradientStart || "") && /^#[0-9a-fA-F]{6}$/.test(st.gradientEnd || "")) {
            return [st.gradientStart, st.gradientEnd];
        }
        return null;
    }

    // strip a leading styled [TAG] from a raw nickname when it matches our tag.
    // without this, the opt-in prefix stacks a second copy ([KING] [KING] ...).
    // tolerates any TMP markup interleaved between the letters.
    function stripLeadingClanTagMarkup(raw) {
        const tag = String(myClan?.tag ?? "").trim();
        if (!raw || !tag) return raw || "";
        const anyTags = "(?:<[^>]*>)*";
        // sanitizeClanTag guarantees A-Z only, no escaping needed
        const letters = [...tag.toUpperCase()].map(ch => ch + anyTags).join("");
        const re = new RegExp("^" + anyTags + "\\[" + anyTags + letters + "\\]" + anyTags + "\\s*", "i");
        return raw.replace(re, "");
    }

    function getClanTagPrefix() {
        if (!myClan || !myClan.tag || !useClanTagPref()) return "";
        const tag = String(myClan.tag).trim();
        if (!tag) return "";
        const st = myClan.tagStyle || {};
        const tagChars = [...tag];
        const mode = st.mode || (st.color ? "solid" : "none");
        const stops = mode === "gradient" ? _tagStops(st) : null;
        const waveOn = !!st.waveOn;
        const waveAmp = Math.max(0, Math.min(45, st.waveAmp ?? 8));
        const rotateDeg = Math.max(-45, Math.min(45, st.rotateDeg ?? 0));
        const bracketColor = /^#[0-9a-fA-F]{6}$/.test(st.bracketColor || "") ? st.bracketColor.toUpperCase() : null;

        // when bracketColor is set, gi runs over letters only so the gradient
        // distributes cleanly inside the brackets
        function emitChar(ch, gi, giMax, forceColor, waveIdx) {
            let piece = "";
            if (waveOn) piece += "<rotate=" + (waveIdx % 2 === 0 ? waveAmp : -waveAmp) + ">";
            if (forceColor) {
                piece += "<" + forceColor + ">";
            } else if (stops) {
                const t = giMax === 0 ? 0 : gi / giMax;
                piece += "<" + _sampleStops(stops, t).toUpperCase() + ">";
            } else if (mode === "solid" && /^#[0-9a-fA-F]{6}$/.test(st.color || "")) {
                // must emit every letter, bracket color tag persists in TMP
                // until changed. was gated on waveOn before which broke solid+bracket.
                piece += "<" + st.color.toUpperCase() + ">";
            }
            return piece + ch;
        }

        let out = "";
        if (!waveOn && rotateDeg !== 0) out += "<rotate=" + rotateDeg + ">";

        // fast path: solid, no wave, no bracket color -> one wrap
        if (mode === "solid" && /^#[0-9a-fA-F]{6}$/.test(st.color || "") && !waveOn && !bracketColor) {
            out += "<" + st.color.toUpperCase() + ">[" + tag + "]";
        } else {
            let wi = 0;
            out += emitChar("[", 0, Math.max(0, tagChars.length - 1), bracketColor, wi++);
            for (let i = 0; i < tagChars.length; i++) {
                const gi = bracketColor ? i : i + 1;
                const giMax = bracketColor ? Math.max(0, tagChars.length - 1) : tagChars.length + 1;
                out += emitChar(tagChars[i], gi, giMax, null, wi++);
            }
            out += emitChar("]", Math.max(0, tagChars.length - 1),
                             Math.max(0, tagChars.length - 1), bracketColor, wi++);
            if (waveOn) out += "<rotate=0>";
        }

        if (!waveOn && rotateDeg !== 0) out += "<rotate=0>";
        if (st.italic) out = "<i>" + out + "</i>";
        if (st.bold) out = "<b>" + out + "</b>";
        return out + " ";
    }

    async function leaveClan() {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const uid = myUserId();

        // leader path handled below (disband/transfer)
        if (!eventPerm("allowLeave") && myClan.leaderId !== uid) {
            showToast("Can't leave during an active event -- ask leader to kick.");
            return;
        }

        try {
            const isLeader = myClan.leaderId === uid;
            const isSoloLeader = isLeader && (myClan.members ?? []).length === 1;
            // disband would erase every contribution the clan has scored
            if (isSoloLeader && !eventPerm("allowDisband")) {
                showToast("Disbanding is locked during this event.");
                return;
            }
            if (isSoloLeader && !rolePerm(myClanRole(), "disband")) {
                showToast("Disbanding is currently disabled.");
                return;
            }
            if (isLeader && (myClan.members ?? []).length > 1) {
                showToast("Transfer leadership or remove others before leaving.");
                return;
            }
            if (isLeader) {
                // solo leader = disband
                dbg(`Clan disbanded (solo leader): ${myClan.id}`);
                detachClanListener();
                await fb.deleteDoc(fb.doc(fb.db, "clans", myClan.id));
            } else {
                dbg(`Clan left: ${myClan.id}`);
                const members = (myClan.members ?? []).filter(m => m.userId !== uid);
                await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            }
            myClan = null;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            pushError(e, "leaveClan");
            console.error("[RG HUD] Leave clan failed:", e);
            // v13.6: local state is already partially wiped above, surface it
            showToast("Couldn't leave clan — refresh the page to retry.");
        }
    }

    // ---------- Clan view rendering ----------

    async function renderClanView() {
        const view = document.getElementById("rgClanView");
        if (!view) return;

        if (!lastKnownPlayerData) {
            view.innerHTML = `<div style="opacity:.8;">Log in or play a match first to use clans.</div>`;
            return;
        }

        view.innerHTML = `<div style="opacity:.8;">Loading clans...</div>`;
        await loadClanData(true);
        const fb = await initFirebase();
        // v13.6: dropped force=true on the two admin config loaders. they
        // change so rarely the first session read is fine to cache. saves ~2
        // Firestore reads per tab open. loadClanData(true) stays because
        // clanless users have no live listener and need a fresh directory.
        if (fb) await loadEventConfig(fb);
        if (fb) await loadClanRolePerms(fb);

        renderClanViewFromMemory();
        if (myClan) attachClanListener();
    }

    // zero-read repaint from in-memory myClan
    function renderClanViewFromMemory() {
        const view = document.getElementById("rgClanView");
        if (!view) return;
        myClan ? renderMyClan(view) : renderNoClan(view);
    }

    // refresh clan tab in place if it's open
    function refreshClanViewIfOpen() {
        const view = document.getElementById("rgClanView");
        if (view && view.style.display !== "none") {
            renderClanViewFromMemory();
            if (myClan) attachClanListener();
        }
    }

    function renderNoClan(view) {
        const rows = clanDirectory
            .slice()
            .sort((a, b) => (b.totalMMR ?? 0) - (a.totalMMR ?? 0))
            .map((c, i) => `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 0;border-bottom:1px solid #ffffff11;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        <span style="color:#ffd700;">#${i + 1}</span>
                        ${c.tag ? `<span style="opacity:.7;">[${escapeHtml(c.tag)}]</span>` : ""}
                        <b>${escapeHtml(c.name)}</b>
                        <span style="opacity:.6;font-size:10px;">(${c.memberCount}/${clanMaxMembers()})</span>
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                        <span style="color:#00ff66;font-size:11px;">${c.totalMMR}</span>
                        <button class="rgBtn rgJoinBtn" data-clan="${c.id}" style="padding:2px 6px;font-size:10px;" ${c.memberCount >= clanMaxMembers() ? "disabled" : ""}>Join</button>
                    </span>
                </div>`).join("");

        view.innerHTML = `
            ${eventBannerHtml(null, myUserId())}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <b>🛡️ Clans</b>
                <button id="rgCreateClanBtn" class="rgBtn" style="padding:3px 8px;font-size:11px;">+ Create</button>
            </div>
            <div style="max-height:200px;overflow-y:auto;">${rows || `<div style="opacity:.7;">No clans yet. Create the first one!</div>`}</div>
        `;

        document.getElementById("rgCreateClanBtn").onclick = showCreateClanForm;
        view.querySelectorAll(".rgJoinBtn").forEach(btn => {
            if (!eventPerm("allowJoin")) {
                btn.disabled = true;
                btn.style.opacity = "0.5";
                btn.style.cursor = "not-allowed";
                btn.title = "Joins locked during event";
                btn.textContent = "Locked (event)";
            } else {
                btn.onclick = () => requestJoin(btn.getAttribute("data-clan"));
            }
        });
    }

    function showCreateClanForm() {
        const view = document.getElementById("rgClanView");
        view.innerHTML = `
            <b>Create a Clan</b>
            <div style="margin-top:8px;">
                <input type="text" id="rgClanName" placeholder="Clan name (max 24)" maxlength="24"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;margin-bottom:6px;user-select:text;">
                <input type="text" id="rgClanTag" placeholder="Tag (2-4 letters, required)" maxlength="4"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;user-select:text;">
                <div id="rgClanErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
                <div style="display:flex;gap:6px;">
                    <button id="rgClanCreateGo" class="rgBtn" style="flex:1;">Create</button>
                    <button id="rgClanCreateCancel" class="rgBtn" style="flex:1;">Cancel</button>
                </div>
            </div>`;

        const nameEl = document.getElementById("rgClanName");
        const tagEl = document.getElementById("rgClanTag");
        const errEl = document.getElementById("rgClanErr");
        probeInput(nameEl, "rgClanName");
        probeInput(tagEl, "rgClanTag");
        [nameEl, tagEl].forEach(el => {
            el.addEventListener("keydown", e => e.stopPropagation(), true);
        });
        // uppercase + letter-only as they type
        tagEl.style.textTransform = "uppercase";
        tagEl.addEventListener("input", () => {
            const clean = sanitizeClanTag(tagEl.value);
            if (tagEl.value !== clean) tagEl.value = clean;
        });

        document.getElementById("rgClanCreateGo").onclick = () => {
            const name = nameEl.value.trim();
            const tag = sanitizeClanTag(tagEl.value);
            if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
            if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag: 2-4 letters, no numbers or symbols."; return; }
            if (containsProfanity(name) || containsEmoji(name)) { errEl.textContent = "That name isn't allowed."; return; }
            if (containsProfanity(tag) || containsEmoji(tag)) { errEl.textContent = "That tag isn't allowed."; return; }
            if (clanDirectory.some(c => (c.tag ?? "").toLowerCase() === tag.toLowerCase())) {
                errEl.textContent = "That tag is already taken."; return;
            }
            createClan(name, tag);
        };
        document.getElementById("rgClanCreateCancel").onclick = renderClanView;
    }

    function renderMyClan(view) {
        const uid = myUserId();
        const me = (myClan.members ?? []).find(m => m.userId === uid);
        const myRole = me?.role ?? "member";
        const rank = [...clanDirectory].sort((a, b) => (b.totalMMR ?? 0) - (a.totalMMR ?? 0))
            .findIndex(c => c.id === myClan.id) + 1;

        // ⋯ menu, per-target rank guards still apply below
        const canManage = rolePerm(myRole, "kick") || rolePerm(myRole, "roleChange");
        // current MMR minus per-member baseline (only during active event)
        const eventActive = eventPhase() === "active";
        const eventBaselines = eventActive ? (clanBaselineForCurrentEvent(myClan) || {}) : {};
        const contribFor = (member) => {
            if (!eventActive) return null;
            const base = eventBaselines[member.userId];
            if (base == null || typeof member.mmr !== "number") return null;
            return member.mmr - base;
        };

        const memberRows = (myClan.members ?? [])
            .slice()
            .sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0))
            .map(m => {
                const actable = canManage && m.userId !== uid && m.role !== "leader"
                    && (ROLE_RANK[m.role] ?? 0) < (ROLE_RANK[myRole] ?? 0);
                const contrib = contribFor(m);
                // shows staleness so "+0" vs "last synced 2h ago" is clear
                const ageMs = typeof m.syncedAt === "number" ? Date.now() - m.syncedAt : null;
                const ageLabel = ageMs == null ? null
                    : ageMs < 90e3 ? "just now"
                    : ageMs < 3600e3 ? `${Math.round(ageMs / 60e3)}m ago`
                    : ageMs < 86400e3 ? `${Math.round(ageMs / 3600e3)}h ago`
                    : `${Math.round(ageMs / 86400e3)}d ago`;
                const freshnessNote = ageLabel ? `· last synced ${ageLabel}` : "· sync age unknown (teammate needs v12.9+)";
                const stale = ageMs != null && ageMs > 3600e3;
                // green gain, red loss, gray dash = hasn't played this event
                const contribHtml = eventActive
                    ? (contrib == null
                        ? `<span title="Hasn't played during this event yet" style="opacity:.4;font-size:10px;font-family:monospace;">—</span>`
                        : `<span title="Event contribution (current MMR - baseline) ${freshnessNote}" style="color:${contrib >= 0 ? "#00ff66" : "#ff6b6b"};opacity:${stale ? ".45" : "1"};font-size:10px;font-weight:bold;font-family:monospace;">${contrib >= 0 ? "+" : ""}${contrib}</span>`)
                    : "";
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${escapeHtml(m.name)}
                        ${typeof m.mmr === "number" ? `<span style="opacity:.5;font-size:10px;">${m.mmr}</span>` : ""}
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                        ${contribHtml}
                        <span style="opacity:.7;font-size:10px;text-transform:uppercase;">${m.role}</span>
                        ${actable ? `<button class="rgBtn rgManage" data-uid="${m.userId}" data-name="${escapeHtml(m.name)}" data-role="${m.role}" style="padding:1px 6px;font-size:10px;">⋯</button>` : ""}
                    </span>
                </div>`;
            }).join("");

        let requestsSection = "";
        if (canManageRequests(myRole) && (myClan.joinRequests ?? []).length > 0) {
            const reqRows = myClan.joinRequests.map(r => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.name)}</span>
                    <span style="display:flex;gap:4px;flex-shrink:0;">
                        <button class="rgBtn rgApprove" data-uid="${r.userId}" style="padding:1px 6px;font-size:10px;">✓</button>
                        <button class="rgBtn rgReject" data-uid="${r.userId}" style="padding:1px 6px;font-size:10px;">✗</button>
                    </span>
                </div>`).join("");
            requestsSection = `
                <hr style="border:none;border-top:1px solid #00bfff88;margin:8px 0;">
                <b>Join Requests</b>
                <div>${reqRows}</div>`;
        }

        const isLeader = myClan.leaderId === uid;
        view.innerHTML = `
            ${eventBannerHtml(myClan, uid)}
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${myClan.tag ? `[${escapeHtml(myClan.tag)}] ` : ""}${escapeHtml(myClan.name)}</b>
                <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    ${rolePerm(myRole, "editClanInfo") ? `<button id="rgEditClan" class="rgBtn" style="padding:1px 6px;font-size:10px;">✏️</button>` : ""}
                    <span style="color:#ffd700;font-size:11px;">Rank #${rank || "-"}</span>
                </span>
            </div>
            <div style="font-size:11px;opacity:.75;margin:2px 0 6px;">
                Total MMR: <span style="color:#00ff66;">${myClan.totalMMR ?? 0}</span>
                &nbsp;•&nbsp; ${(myClan.members ?? []).length}/${clanMaxMembers()} members
            </div>
            <div id="rgMembersHeader" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:2px 0;margin-top:2px;">
                <span id="rgMembersArrow" style="font-size:9px;opacity:.7;width:8px;display:inline-block;">▶</span>
                <b>Members</b>
            </div>
            <div id="rgMembersList" style="display:none;">${memberRows}</div>
            ${requestsSection}
            <div id="rgClanTagPanel" style="margin-top:10px;padding:8px;border:1px solid #00bfff44;border-radius:6px;">
                <div id="rgClanTagHeader" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
                    <span id="rgClanTagArrow" style="font-size:9px;opacity:.7;width:8px;display:inline-block;">▶</span>
                    <span style="font-size:11px;font-weight:bold;color:#00bfff;">CLAN TAG STYLE</span>
                </div>
                <div id="rgClanTagBody" style="display:none;margin-top:6px;"></div>
            </div>
            <button id="rgLeaveClan" class="rgBtn" style="width:100%;margin-top:8px;">Leave Clan</button>
        `;

        if (rolePerm(myRole, "editClanInfo")) {
            const editBtn = document.getElementById("rgEditClan");
            if (editBtn) editBtn.onclick = showEditClanForm;
        }

        // collapsed by default to save HUD height
        const mHeader = document.getElementById("rgMembersHeader");
        if (mHeader) {
            mHeader.onclick = () => {
                const list = document.getElementById("rgMembersList");
                const arrow = document.getElementById("rgMembersArrow");
                const open = list.style.display !== "none";
                list.style.display = open ? "none" : "block";
                arrow.textContent = open ? "▶" : "▼";
            };
        }
        // renderClanTagPanel still runs so the preview is ready when opened
        const tHeader = document.getElementById("rgClanTagHeader");
        if (tHeader) {
            tHeader.onclick = () => {
                const body = document.getElementById("rgClanTagBody");
                const arrow = document.getElementById("rgClanTagArrow");
                const open = body.style.display !== "none";
                body.style.display = open ? "none" : "block";
                arrow.textContent = open ? "▶" : "▼";
            };
        }

        view.querySelectorAll(".rgApprove").forEach(b => b.onclick = () => approveRequest(b.getAttribute("data-uid"), true));
        view.querySelectorAll(".rgReject").forEach(b => b.onclick = () => approveRequest(b.getAttribute("data-uid"), false));
        view.querySelectorAll(".rgManage").forEach(b => b.onclick = async () => {
            const tUid = b.getAttribute("data-uid");
            const tName = b.getAttribute("data-name");
            const tRole = b.getAttribute("data-role");
            await showManageMemberMenu(tUid, tName, tRole, myRole, myClan.leaderId === uid);
        });
        renderClanTagPanel();
        // gray out Leave for non-leader members when allowLeave is off
        if (!eventPerm("allowLeave") && myClan && myClan.leaderId !== myUserId()) {
            const lb = document.getElementById("rgLeaveClan");
            if (lb) {
                lb.disabled = true;
                lb.style.opacity = "0.5";
                lb.style.cursor = "not-allowed";
                lb.title = "Locked during active event";
                lb.textContent = "Leave Clan (locked during event)";
            }
        }
                document.getElementById("rgLeaveClan").onclick = async () => {
            const sure = await showDialog({ message: "Leave this clan?", okLabel: "Leave", cancelLabel: "Cancel" });
            if (sure) leaveClan();
        };
    }

    // themed alert/confirm/prompt
    let toastTimeout = null;
    function showToast(msg) {
        createHUD();
        const t = document.getElementById("rgToast");
        if (!t) return;
        t.textContent = msg;
        t.style.opacity = "1";
        t.style.transform = "translateY(0)";
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            t.style.opacity = "0";
            t.style.transform = "translateY(8px)";
        }, 2800);
    }

    // confirm -> bool. prompt -> string or null.
    function showDialog({ message, withInput = false, inputPlaceholder = "", okLabel = "OK", cancelLabel = "Cancel" }) {
        return new Promise(resolve => {
            createHUD();
            const previousFocus = document.activeElement;
            let restorePreviousFocus = false;
            try { restorePreviousFocus = !!previousFocus?.matches?.(":focus-visible"); } catch (e) {}
            const dlg = document.getElementById("rgDialog");
            const msgEl = document.getElementById("rgDialogMsg");
            const input = document.getElementById("rgDialogInput");
            const okBtn = document.getElementById("rgDialogOk");
            const cancelBtn = document.getElementById("rgDialogCancel");

            msgEl.textContent = message;
            // v13.6: preserve line breaks for multi-line messages (session recap)
            msgEl.style.whiteSpace = "pre-wrap";
            okBtn.textContent = okLabel;
            cancelBtn.textContent = cancelLabel;
            // v13.6: empty label -> no phantom cancel button on info dialogs
            cancelBtn.style.display = cancelLabel ? "" : "none";
            input.style.display = withInput ? "block" : "none";
            input.value = "";
            input.placeholder = inputPlaceholder;
            dlg.style.display = "flex";
            setTimeout(() => (withInput ? input : okBtn).focus(), 50);
            if (withInput) probeInput(input, "rgDialogInput");

            const close = result => {
                dlg.style.display = "none";
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                resolve(result);
                setTimeout(() => {
                    if (restorePreviousFocus && previousFocus?.isConnected) {
                        previousFocus.focus({ preventScroll: true });
                    }
                }, 0);
            };
            okBtn.onclick = () => close(withInput ? input.value.trim() : true);
            cancelBtn.onclick = () => close(withInput ? null : false);
        });
    }

    // rendered temporarily into the clan view
    async function showManageMemberMenu(userId, name, targetRole, actorRole, actorIsLeader) {
        const view = document.getElementById("rgClanView");
        if (!view) return;

        const actions = [];
        // any role strictly below the actor that isn't the current one
        const assignable = ["coleader", "elder", "member"].filter(r =>
            r !== targetRole && canSetRole(actorRole, targetRole, r)
        );
        for (const r of assignable) {
            const verb = (ROLE_RANK[r] > ROLE_RANK[targetRole]) ? "Promote to" : "Demote to";
            actions.push({ label: `${verb} ${r}`, run: () => setMemberRole(userId, r) });
        }
        if (actorIsLeader && rolePerm(actorRole, "transfer")) {
            actions.push({ label: "👑 Transfer leadership", danger: true, run: async () => {
                const sure = await showDialog({
                    message: `Make ${name} the clan leader? You'll become co-leader.`,
                    okLabel: "Transfer", cancelLabel: "Cancel",
                });
                if (sure) transferLeadership(userId);
            }});
        }
        if (rolePerm(actorRole, "kick")) actions.push({ label: "❌ Kick from clan", danger: true, run: async () => {
            const sure = await showDialog({ message: `Kick ${name} from the clan?`, okLabel: "Kick", cancelLabel: "Cancel" });
            if (!sure) { renderClanView(); return; }
            const msg = await showDialog({
                message: `Optional message to ${name} (leave blank to skip):`,
                withInput: true, inputPlaceholder: "Message...", okLabel: "Send", cancelLabel: "No message",
            });
            kickMember(userId, msg || "");
        }});

        const btns = actions.map((a, i) =>
            `<button class="rgBtn rgMgAction" data-i="${i}" style="width:100%;margin-bottom:4px;${a.danger ? "border-color:#ff6b6b88;" : ""}">${a.label}</button>`
        ).join("");

        view.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b>Manage ${escapeHtml(name)}</b>
                <span style="opacity:.6;font-size:10px;text-transform:uppercase;">${targetRole}</span>
            </div>
            ${btns}
            <button id="rgMgBack" class="rgBtn" style="width:100%;margin-top:6px;">Back</button>
        `;

        view.querySelectorAll(".rgMgAction").forEach(btn => {
            btn.onclick = () => actions[parseInt(btn.getAttribute("data-i"))].run();
        });
        document.getElementById("rgMgBack").onclick = renderClanView;
    }

    function escapeHtml(s) {
        return String(s ?? "").replace(/[&<>"']/g, c => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
    }

    // v13.6: on-demand session summary. plain text via showDialog.
    function showSessionRecap() {
        if (!sessionStart) {
            showDialog({ message: "No session data yet. Log in or play a match, then check back.", okLabel: "OK", cancelLabel: "" });
            return;
        }
        const lines = [];
        const ms = Date.now() - sessionStart.startedAt;
        const minutes = Math.floor(ms / 60000);
        const hours = Math.floor(minutes / 60);
        const minPart = minutes % 60;
        lines.push(`Session length: ${hours > 0 ? hours + "h " : ""}${minPart}m`);

        const data = lastKnownPlayerData;
        if (data && data.ModesGlicko) {
            lines.push("");
            lines.push("MMR change this session:");
            const modes = [
                ["Competitive3v3", "3v3"],
                ["Competitive2v2", "2v2"],
                ["Competitive1v1", "1v1"],
                ["Casual", "Casual"],
            ];
            let anyMovement = false;
            for (const [key, label] of modes) {
                const start = sessionStart[key];
                const now = data.ModesGlicko[key]?.displayRating;
                if (typeof start === "number" && typeof now === "number") {
                    const d = now - start;
                    if (d !== 0) anyMovement = true;
                    const sign = d > 0 ? "+" : "";
                    lines.push(`  ${label}: ${now} (${sign}${d})`);
                }
            }
            if (!anyMovement) lines.push("  (no ranked matches counted yet)");
        }

        if (streakData && streakData.streak !== 0) {
            const n = streakData.streak;
            lines.push("");
            lines.push(n > 0 ? `Current streak: 🔥 ${n} wins in a row` : `Current streak: ❄️ ${-n} losses in a row`);
        }

        if (eventPhase && eventPhase() === "active" && myClan) {
            const uid = myUserId();
            const contribution = myEventContribution(myClan, uid);
            const clanScore = computeClanEventScore(myClan);
            const standings = eventStandings();
            const rank = standings.findIndex(c => c.id === myClan.id) + 1;
            lines.push("");
            lines.push(`Clan Clash: ${eventConfig?.name || "current event"}`);
            if (typeof contribution === "number") {
                const sign = contribution >= 0 ? "+" : "";
                lines.push(`  Your contribution: ${sign}${contribution}`);
            }
            const clanSign = clanScore >= 0 ? "+" : "";
            lines.push(`  Clan total: ${clanSign}${clanScore}${rank ? `  (#${rank}/${standings.length})` : ""}`);
        }

        showDialog({ message: lines.join("\n"), okLabel: "Close", cancelLabel: "" });
    }

    // ---------- Boot ----------

    const wait = setInterval(() => {
        if (document.body) {
            clearInterval(wait);
            createHUD();
            console.log("[RG HUD] loaded and running, waiting for login/matchEnd data...");
        }
    }, 100);

    // v13.6: watchdog for _inMatch. if the game silently reconnects without
    // emitting matchEnd/LeaveRoom, the HUD stays hidden forever. 10min
    // exceeds any real match so we won't clobber legit state.
    const INMATCH_STALE_MS = 10 * 60 * 1000;
    setInterval(() => {
        if (!_inMatch) return;
        const now = performance.now();
        const initStale = (now - _lastInitLineAt) > INMATCH_STALE_MS;
        const recoveryRecent = _lastRecoverySignalAt > 0
            && (now - _lastRecoverySignalAt) < 60 * 1000;
        if (initStale && recoveryRecent) {
            dbg(`_inMatch watchdog: stale for ${((now - _lastInitLineAt) / 60000).toFixed(1)}m + recent recovery signal -- clearing`);
            _inMatch = false;
            setAutoVisible(true);
        }
    }, 60 * 1000);


    // ==================================================================
    // 🎨 NAME FORGE. rich-text in-game nickname builder.
    // wrapped so helper names (esc, el, ...) don't collide with the HUD.
    // edits the IN-GAME nickname; ✏️ Rename edits the leaderboard name.
    // ==================================================================
    const RGNF = (function () {
      let _rgnfFab = null, _rgnfPanel = null;

  // ---- Constants ----
  const API_URL = 'https://us-central1-rocketball-23c12.cloudfunctions.net/v0304_player/nickname';
  const STORE_KEY = 'rgNameForge.presets.v1';
  const STATE_KEY_LEGACY = 'rgNameForge.lastState.v1';
  // per-account state, legacy key read once as fallback on upgrade
  let _currentUserId = null;
  let _lastRawNickname = '';
  const stateKey = () => _currentUserId ? ('rgNameForge.state.v5.' + _currentUserId) : STATE_KEY_LEGACY;
  const HISTORY_KEY = 'rgNameForge.history.v1';
  // steal receipt. boot-time SetNickname echo can undo a fresh steal, so
  // we re-apply once after boot if the login nickname doesn't match.
  const pendingStealKey = () => 'rgNameForge.pendingSteal.v1.' + (_currentUserId || 'anon');
  const PENDING_STEAL_TTL_MS = 15 * 60 * 1000;
  const FABPOS_KEY = 'rgNameForge.fabPos.v1';
  const PALETTES = [
    { label: '🔥 Fire', stops: ['#FF4D00', '#FFB800', '#FF0000'] },
    { label: '🌊 Ocean', stops: ['#00FFFF', '#0000FF'] }, // matches RootedEngineering ramp
    { label: '🌈 Rainbow', stops: ['#FF0000', '#FFFF00', '#00FF00', '#00BFFF', '#8B00FF'] },
    { label: '🌇 Sunset', stops: ['#FF6B6B', '#FFB347', '#8E44AD'] },
    { label: '☢️ Toxic', stops: ['#39FF14', '#CCFF00', '#00FF9F'] },
    { label: '❄️ Ice', stops: ['#E0FFFF', '#7DD3FC', '#2563EB'] },
  ];
  // sprite atlas from in-game screenshot (0-15, left to right)
  const SPRITES = [
    { n: 0,  e: '😊', label: 'Blush smile' },
    { n: 1,  e: '😋', label: 'Tongue-savoring' },
    { n: 2,  e: '😍', label: 'Heart eyes' },
    { n: 3,  e: '😎', label: 'Sunglasses' },
    { n: 4,  e: '😀', label: 'Grinning' },
    { n: 5,  e: '😄', label: 'Smile eyes' },
    { n: 6,  e: '😅', label: 'Sweat smile' },
    { n: 7,  e: '😁', label: 'Beaming' },
    { n: 8,  e: '😆', label: 'Big laugh' },
    { n: 9,  e: '😂', label: 'Tears of joy' },
    { n: 10, e: '😤', label: 'Frustrated' },
    { n: 11, e: '🤪', label: 'Zany wink' },
    { n: 12, e: '❓', label: 'Broken sprite (renders as ? box in-game)', broken: true },
    { n: 13, e: '🤣', label: 'Rolling (renders tilted in-game)' },
    { n: 14, e: '🙂', label: 'Slight smile' },
    { n: 15, e: '😕', label: 'Confused' },
  ];
  const spriteEmoji = (n) => (SPRITES.find(s => s.n === n) || { e: '☺' }).e;

  // ---- State ----
  const defaultState = () => ({
    name: 'RootedEngineering',
    colorMode: 'gradient',            // 'none' | 'solid' | 'gradient'
    solidColor: '#22d3ee',
    stops: ['#22d3ee', '#e94fff'],    // 2-5 gradient stops
    skipSpaces: true,                 // don't waste tags coloring spaces
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    sizePct: 100,                     // <size=N%>
    rotateDeg: 0,                     // <rotate=N>
    waveOn: false,                    // per-letter alternating rotation
    waveAmp: 12,                      // wave tilt degrees
    markOn: false,
    markColor: '#facc15',
    markAlpha: 64,                    // 0-255 -> hex alpha appended to mark color
    titleOn: false,
    titleText: '',
    titleColorMode: 'solid',          // 'inherit' | 'solid' | 'gradient'
    titleColor: '#94a3b8',
    titleSizePct: 60,
    titleSub: true,                   // wrap title in <sub> for that low-set look
    // title has its own styling now, used to borrow name's stops
    titleStops: ['#ff8fb1', '#a78bfa'],
    titlePaletteKey: null,
    titleBold: false,
    titleItalic: false,
    titleUnderline: false,
    titleStrike: false,
    titleAlpha: 255,                  // 0-255 alpha on titleColor (solid only)
    // alpha on the name's solid color, dims trailing URL text etc
    solidAlpha: 255,
    scoredMode: 'default',            // 'default' | 'hide' | 'tiny' | 'styled'
    scoredColor: '#22d3ee',
    scoredSizePct: 100,
    rawCode: null,                    // when set: exact current in-game markup, used verbatim
  });

  let state = loadJSON(stateKey(), null) || loadJSON(STATE_KEY_LEGACY, defaultState());
  // backfill any new fields if an old state was saved
  state = Object.assign(defaultState(), state);

  // ---- Utilities ----
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
      r: parseInt(h.substring(0, 2), 16),
      g: parseInt(h.substring(2, 4), 16),
      b: parseInt(h.substring(4, 6), 16),
    };
  }

  function rgbToHex({ r, g, b }) {
    const c = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
    return `#${c(r)}${c(g)}${c(b)}`;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function lerpColor(c1, c2, t) {
    const a = hexToRgb(c1), b = hexToRgb(c2);
    return rgbToHex({ r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) });
  }

  // multi-stop gradient sample at t in [0,1]
  function gradientAt(stops, t) {
    if (stops.length === 1) return stops[0].toUpperCase();
    const seg = 1 / (stops.length - 1);
    const idx = Math.min(Math.floor(t / seg), stops.length - 2);
    const localT = (t - idx * seg) / seg;
    return lerpColor(stops[idx], stops[idx + 1], localT);
  }

  function alphaHex(n) {
    return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return rgbToHex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
  }

  function randomStops() {
    const h = Math.floor(Math.random() * 360);
    const spread = 80 + Math.floor(Math.random() * 160);
    return [h, h + spread / 2, h + spread].map((x) => hslToHex(((x % 360) + 360) % 360, 95, 55));
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ------------------------------------------------------------------
  // TMP code generation
  // ------------------------------------------------------------------
  function colorizeText(text, mode, solid, stops, skipSpaces, waveAmp = 0) {
    const wave = waveAmp !== 0;

    // fast paths when no per-letter work is needed
    if (!wave && mode === 'none') return text;
    if (!wave && mode === 'solid') return `<${solid.toUpperCase()}>` + text;

    const tokens = tokenize(text);
    const paintable = tokens.filter(t => t.type === 'char' && !(skipSpaces && t.value === ' '));
    const n = paintable.length;
    if (n === 0) return mode === 'solid' ? `<${solid.toUpperCase()}>` + text : text;

    let i = 0;
    let lastColor = null;
    let out = '';
    if (mode === 'solid') {
      const aaN = (s.solidAlpha ?? 255) < 255 ? alphaHex(s.solidAlpha) : '';
      out += `<${solid.toUpperCase()}${aaN}>`;
    }
    for (const tok of tokens) {
      if (tok.type === 'sprite') { out += tok.value; continue; }
      if (skipSpaces && tok.value === ' ') { out += ' '; continue; }
      if (wave) out += `<rotate=${i % 2 === 0 ? waveAmp : -waveAmp}>`;
      if (mode === 'gradient') {
        const t = n === 1 ? 0 : i / (n - 1);
        const col = gradientAt(stops, t);
        if (col !== lastColor) { out += `<${col}>`; lastColor = col; }
      }
      out += tok.value;
      i++;
    }
    if (wave) out += '<rotate=0>'; // reset so trailing title/Scored! stays level
    return out;
  }

  // chars, but <sprite=N> tags stay as single tokens
  function tokenize(text) {
    const tokens = [];
    const re = /<sprite=\d+>/g;
    let lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const ch of text.slice(lastIndex, m.index)) tokens.push({ type: 'char', value: ch });
      tokens.push({ type: 'sprite', value: m[0] });
      lastIndex = m.index + m[0].length;
    }
    for (const ch of text.slice(lastIndex)) tokens.push({ type: 'char', value: ch });
    return tokens;
  }

  function buildCode(s) {
    let open = '';
    let close = '';

    if (s.rotateDeg !== 0 && !s.waveOn) open += `<rotate=${s.rotateDeg}>`;
    if (s.sizePct !== 100) open += `<size=${s.sizePct}%>`;
    if (s.markOn) { open += `<mark=${s.markColor.toUpperCase()}${alphaHex(s.markAlpha)}>`; close = '</mark>' + close; }
    if (s.bold) { open += '<b>'; close = '</b>' + close; }
    if (s.italic) { open += '<i>'; close = '</i>' + close; }
    if (s.underline) { open += '<u>'; close = '</u>' + close; }
    if (s.strike) { open += '<s>'; close = '</s>' + close; }

    const nameCode = colorizeText(s.name, s.colorMode, s.solidColor, s.stops, s.skipSpaces, s.waveOn ? s.waveAmp : 0);

    let code = open + nameCode + close;

    // title line, fully independent styling
    if (s.titleOn && s.titleText.trim().length > 0) {
      let t = s.titleText;
      if (s.titleColorMode === 'solid') {
        const aa = (s.titleAlpha ?? 255) < 255 ? alphaHex(s.titleAlpha) : '';
        t = `<${s.titleColor.toUpperCase()}${aa}>` + t;
      } else if (s.titleColorMode === 'gradient') {
        t = colorizeText(t, 'gradient', s.titleColor, s.titleStops, s.skipSpaces);
        // append alpha byte to every <#RRGGBB> so gradients can be transparent too
        const aaG = (s.titleAlpha ?? 255) < 255 ? alphaHex(s.titleAlpha) : '';
        if (aaG) t = t.replace(/<(#[0-9A-Fa-f]{6})>/g, `<$1${aaG}>`);
      }
      let tOpen = '', tClose = '';
      if (s.titleSizePct !== 100) tOpen += `<size=${s.titleSizePct}%>`;
      if (s.titleSub) { tOpen += '<sub>'; tClose = '</sub>' + tClose; }
      if (s.titleBold) { tOpen += '<b>'; tClose = '</b>' + tClose; }
      if (s.titleItalic) { tOpen += '<i>'; tClose = '</i>' + tClose; }
      if (s.titleUnderline) { tOpen += '<u>'; tClose = '</u>' + tClose; }
      if (s.titleStrike) { tOpen += '<s>'; tClose = '</s>' + tClose; }
      code += '<br>' + tOpen + t + tClose;
    }

    // trailing tags to style whatever "Scored!" text the game appends
    switch (s.scoredMode) {
      case 'hide': code += '<size=0>'; break;
      case 'tiny': code += '<sub><size=25%>'; break;
      case 'styled': code += `<size=${s.scoredSizePct}%><${s.scoredColor.toUpperCase()}>`; break;
      default: break;
    }

    return code;
  }

  // ------------------------------------------------------------------
  // preview rendering (approximates TMP output)
  // ------------------------------------------------------------------
  function renderPreview(s) {
    const wrap = document.createElement('div');
    wrap.className = 'rgnf-preview-inner';

    const nameLine = document.createElement('div');
    nameLine.className = 'rgnf-preview-name';

    const styles = [];
    if (s.bold) styles.push('font-weight:700');
    if (s.italic) styles.push('font-style:italic');
    // per-letter decoration mirrors in-game TMP. applied per-span below via decoCSS.
    if (s.sizePct !== 100) styles.push(`font-size:${Math.max(8, 18 * s.sizePct / 100)}px`);
    if (s.markOn) styles.push(`background:${s.markColor}${alphaHex(s.markAlpha)}`);
    nameLine.style.cssText = styles.join(';');

    // clan tag prefix: parse a small TMP subset into styled DOM so the preview
    // matches what actually gets sent
    const pfx = _prefix();
    if (pfx) {
      let inner = pfx;
      let outerBold = false, outerItalic = false;
      let m;
      while ((m = inner.match(/^<b>([\s\S]*)<\/b>\s*$/))) { outerBold = true; inner = m[1]; }
      while ((m = inner.match(/^<i>([\s\S]*)<\/i>\s*$/))) { outerItalic = true; inner = m[1]; }
      const pfxWrap = document.createElement('span');
      if (outerBold) pfxWrap.style.fontWeight = '700';
      if (outerItalic) pfxWrap.style.fontStyle = 'italic';
      pfxWrap.style.marginRight = '4px';
      let idx = 0, currentColor = null, currentRotate = 0;
      while (idx < inner.length) {
        const rest = inner.slice(idx);
        const colorTag = rest.match(/^<(#[0-9A-Fa-f]{6})>/);
        if (colorTag) { currentColor = colorTag[1]; idx += colorTag[0].length; continue; }
        const rotateTag = rest.match(/^<rotate=(-?\d+)>/);
        if (rotateTag) { currentRotate = Number(rotateTag[1]); idx += rotateTag[0].length; continue; }
        const ch = inner[idx];
        const chSpan = document.createElement('span');
        chSpan.textContent = ch;
        if (currentColor) chSpan.style.color = currentColor;
        if (currentRotate) {
          chSpan.style.display = 'inline-block';
          chSpan.style.transform = 'rotate(' + currentRotate + 'deg)';
        }
        pfxWrap.appendChild(chSpan);
        idx++;
      }
      nameLine.appendChild(pfxWrap);
    }


    const decoParts = [];
    if (s.underline) decoParts.push('underline');
    if (s.strike) decoParts.push('line-through');
    const decoCSS = decoParts.length ? decoParts.join(' ') : '';

    const tokens = tokenize(s.name);
    const paintable = tokens.filter(t => t.type === 'char' && !(s.skipSpaces && t.value === ' '));
    const n = paintable.length;
    let i = 0;
    for (const tok of tokens) {
      const span = document.createElement('span');
      if (tok.type === 'sprite') {
        const num = Number(tok.value.match(/\d+/)[0]);
        span.textContent = spriteEmoji(num);
        span.title = tok.value;
      } else {
        span.textContent = tok.value;
        if (tok.value !== ' ' || !s.skipSpaces) {
          if (s.colorMode === 'solid') {
            const aa = (s.solidAlpha ?? 255) < 255 ? alphaHex(s.solidAlpha) : '';
            span.style.color = s.solidColor + aa;
          }
          else if (s.colorMode === 'gradient' && n > 0 && tok.value !== ' ') {
            const t = n === 1 ? 0 : i / (n - 1);
            span.style.color = gradientAt(s.stops, t);
          }
        }
        // per-span decoration, survives rotate + inherits glyph color
        if (decoCSS && tok.value !== ' ') {
          span.style.textDecorationLine = decoCSS;
          span.style.textDecorationColor = span.style.color || 'currentColor';
          span.style.textDecorationThickness = 'from-font';
        }
        if (tok.value !== ' ') {
          if (s.waveOn) {
            span.style.display = 'inline-block';
            span.style.transform = `rotate(${(i % 2 === 0 ? -1 : 1) * s.waveAmp}deg)`;
          }
          i++;
        }
      }
      if (!s.waveOn && s.rotateDeg !== 0) {
        span.style.display = 'inline-block';
        span.style.transform = `rotate(${s.rotateDeg}deg)`;
      }
      nameLine.appendChild(span);
    }
    wrap.appendChild(nameLine);

    if (s.titleOn && s.titleText.trim()) {
      const titleLine = document.createElement('div');
      titleLine.className = 'rgnf-preview-title';
      titleLine.style.fontSize = `${Math.max(7, 18 * s.titleSizePct / 100)}px`;
      if (s.titleSub) titleLine.style.verticalAlign = 'sub';
      if (s.titleBold) titleLine.style.fontWeight = '700';
      if (s.titleItalic) titleLine.style.fontStyle = 'italic';
      const titleDeco = [];
      if (s.titleUnderline) titleDeco.push('underline');
      if (s.titleStrike) titleDeco.push('line-through');
      if (titleDeco.length) titleLine.style.textDecorationLine = titleDeco.join(' ');
      if (s.titleColorMode === 'solid') {
        titleLine.textContent = s.titleText;
        // 8-digit hex: append alpha byte when < 255
        const aa = (s.titleAlpha ?? 255) < 255 ? alphaHex(s.titleAlpha) : '';
        titleLine.style.color = s.titleColor + aa;
      } else if (s.titleColorMode === 'gradient') {
        // use titleStops (was leaking s.stops from the name)
        const chars = [...s.titleText];
        const paint = chars.filter(c => c !== ' ').length;
        const aa = (s.titleAlpha ?? 255) < 255 ? alphaHex(s.titleAlpha) : '';
        let j = 0;
        for (const c of chars) {
          const sp = document.createElement('span');
          sp.textContent = c;
          if (c !== ' ') {
            sp.style.color = gradientAt(s.titleStops, paint === 1 ? 0 : j / (paint - 1)) + aa;
            j++;
          }
          titleLine.appendChild(sp);
        }
      } else {
        titleLine.textContent = s.titleText;
      }
      wrap.appendChild(titleLine);
    }

    // fake "Scored!" suffix
    const scored = document.createElement('span');
    scored.className = 'rgnf-preview-scored';
    scored.textContent = ' Scored!';
    switch (s.scoredMode) {
      case 'hide': scored.style.display = 'none'; break;
      case 'tiny': scored.style.fontSize = '6px'; scored.style.verticalAlign = 'sub'; break;
      case 'styled':
        scored.style.color = s.scoredColor;
        scored.style.fontSize = `${Math.max(6, 14 * s.scoredSizePct / 100)}px`;
        break;
      default: scored.style.color = '#cbd5e1'; break;
    }
    nameLine.appendChild(scored);

    return wrap;
  }

  // ------------------------------------------------------------------
  // auth: fresh Firebase ID token. SDK first, IndexedDB fallback + refresh.
  // ------------------------------------------------------------------
  async function getIdToken() {
    // 1) Firebase SDK exposed on the page
    try {
      if (window.firebase && window.firebase.auth) {
        const u = window.firebase.auth().currentUser;
        if (u) return await u.getIdToken();
      }
    } catch (e) { /* fall through */ }

    // 2) IndexedDB cache written by the Firebase JS SDK
    const rec = await readAuthFromIDB();
    if (!rec) throw new Error('No Firebase auth found. Are you logged in on this tab?');

    const { apiKey, sts } = rec;
    const expMs = Number(sts.expirationTime || 0);
    if (Date.now() < expMs - 60_000 && sts.accessToken) return sts.accessToken;

    // 3) Token expired, refresh it
    const resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sts.refreshToken }),
    });
    if (!resp.ok) throw new Error(`Token refresh failed (${resp.status})`);
    const j = await resp.json();
    if (!j.access_token) throw new Error('Token refresh returned no access_token');
    return j.access_token;
  }

  function readAuthFromIDB() {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('firebaseLocalStorageDb'); } catch (e) { return resolve(null); }
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('firebaseLocalStorage', 'readonly');
          const store = tx.objectStore('firebaseLocalStorage');
          const all = store.getAll();
          all.onsuccess = () => {
            const rows = all.result || [];
            const row = rows.find(r => typeof r.fbase_key === 'string' && r.fbase_key.startsWith('firebase:authUser:'));
            if (!row || !row.value || !row.value.stsTokenManager) return resolve(null);
            const apiKey = row.fbase_key.split(':')[2];
            resolve({ apiKey, sts: row.value.stsTokenManager });
          };
          all.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      };
    });
  }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  async function applyNickname(code) {
    const token = await getIdToken();
    // guard: IndexedDB fallback can serve a stale token in multi-account
    // browsers and apply to the WRONG account. fail loudly instead.
    let mismatch = null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (_currentUserId && payload.user_id && payload.user_id !== _currentUserId) {
        mismatch = payload.user_id;
      }
    } catch (e) { /* undecodable token: proceed, the server will judge it */ }
    if (mismatch) {
      throw new Error('Auth token belongs to a different account (' + mismatch.slice(0, 8) + '…). Refresh the page and try again.');
    }
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Bearer ' + token,
      },
      body: new URLSearchParams({ nickname: code }),
    });
    const body = await res.text();
    // log every apply's server verdict, helps debug "why didn't my name change"
    console.log('[RG HUD] nickname apply ->', res.status, body.trim().slice(0, 60));
    return { ok: res.ok && body.trim() === 'true', status: res.status, body };
  }

  // once per page load: check the last steal survived the game's boot echo.
  // mismatch -> re-apply once after 4s so our write lands last. TTL-bound.
  let _stealVerified = false;
  function verifyPendingSteal(rawNickname) {
    if (_stealVerified) return;
    _stealVerified = true;
    const fdbg = (m) => { try { dbg(m); } catch (e) { console.log('[RG HUD] ' + m); } };
    const pending = loadJSON(pendingStealKey(), null);
    if (!pending || !pending.code) return;
    if (Date.now() - (pending.ts || 0) > PENDING_STEAL_TTL_MS) {
      saveJSON(pendingStealKey(), null);
      fdbg('pending steal receipt expired — dropped');
      return;
    }
    const nick = String(rawNickname || '');
    // v13.6: caller has stripped clan-tag prefix from nick, pending.* wasn't
    // stripped. compare both forms or same-clan steals ping-pong forever.
    let stripFn;
    try { stripFn = stripLeadingClanTagMarkup; } catch (e) { stripFn = s => s; }
    const strip = s => { try { return stripFn(String(s || "")); } catch (e) { return String(s || ""); } };
    const nickStripped = strip(nick);
    const bodyStripped = strip(pending.body);
    const codeStripped = strip(pending.code);
    if (nick && (
        nick === String(pending.body || '') ||
        nick === String(pending.code || '') ||
        (nickStripped && (nickStripped === bodyStripped || nickStripped === codeStripped))
    )) {
      saveJSON(pendingStealKey(), null);
      fdbg('pending steal verified — stolen name stuck server-side');
      return;
    }
    fdbg('pending steal MISMATCH — boot echo overwrote the stolen name, re-applying in 4s');
    setTimeout(async () => {
      try {
        const r = await applyNickname(pending.code);
        fdbg(`pending steal re-apply -> ${r.ok ? 'OK — refresh once more to see it in-game' : 'FAILED (' + r.status + ')'}`);
        if (r.ok) saveJSON(pendingStealKey(), null);
      } catch (err) {
        fdbg('pending steal re-apply error: ' + (err && err.message ? err.message : err));
      }
    }, 4000);
  }

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------
  const css = `
    :root {
      --rgnf-bg: #0b0e1a;
      --rgnf-panel: #10142a;
      --rgnf-panel-2: #171c38;
      --rgnf-line: #23294d;
      --rgnf-text: #e2e8f0;
      --rgnf-muted: #8b93b8;
      --rgnf-accent: #22d3ee;
      --rgnf-accent-2: #e94fff;
    }
    .rgnf-fab {
      position: fixed; bottom: 90px; right: 18px; z-index: 999999;
      width: 52px; height: 52px; border-radius: 14px; border: 1px solid var(--rgnf-line);
      background: linear-gradient(135deg, var(--rgnf-panel) 0%, var(--rgnf-panel-2) 100%);
      color: var(--rgnf-accent); font-size: 24px; cursor: pointer;
      box-shadow: 0 6px 24px rgba(0,0,0,.5), 0 0 0 1px rgba(34,211,238,.15) inset;
      transition: transform .15s ease;
      display: flex; align-items: center; justify-content: center;
      touch-action: none; user-select: none;
    }
    .rgnf-fab:hover { transform: translateY(-2px) scale(1.04); }
    .rgnf-fab:active { cursor: grabbing; }
    .rgnf-panel {
      /* fly-out positioning + 360px is in .rgnf-open, base fills container */
      color: var(--rgnf-text);
      font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
      display: none;
      width: 100%; box-sizing: border-box;
    }
    .rgnf-panel.rgnf-open {
      position: fixed; bottom: 82px; right: 18px; z-index: 999999;
      width: 360px; max-height: 78vh; overflow-y: auto;
      background: var(--rgnf-bg);
      border: 1px solid var(--rgnf-line); border-radius: 16px;
      box-shadow: 0 16px 48px rgba(0,0,0,.6);
      display: block;
    }
    .rgnf-head {
      position: sticky; top: 0; z-index: 2;
      padding: 14px 16px; cursor: grab;
      background: linear-gradient(90deg, rgba(34,211,238,.12), rgba(233,79,255,.12)), var(--rgnf-bg);
      border-bottom: 1px solid var(--rgnf-line);
      display: flex; align-items: center; justify-content: space-between;
    }
    .rgnf-head b {
      font-size: 14px; letter-spacing: .08em; text-transform: uppercase;
      background: linear-gradient(90deg, var(--rgnf-accent), var(--rgnf-accent-2));
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .rgnf-x { background: none; border: none; color: var(--rgnf-muted); font-size: 16px; cursor: pointer; }
    .rgnf-sec { padding: 12px 16px; border-bottom: 1px solid var(--rgnf-line); }
    .rgnf-sec h4 {
      margin: 0 0 8px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
      color: var(--rgnf-muted); font-weight: 600;
    }
    .rgnf-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
    .rgnf-row label { color: var(--rgnf-muted); min-width: 74px; }
    .rgnf-panel input[type=text], .rgnf-panel select {
      flex: 1; min-width: 0; background: var(--rgnf-panel); color: var(--rgnf-text);
      border: 1px solid var(--rgnf-line); border-radius: 8px; padding: 7px 9px; font-size: 13px;
    }
    .rgnf-panel input[type=color] {
      width: 34px; height: 28px; padding: 0; border: 1px solid var(--rgnf-line);
      border-radius: 6px; background: none; cursor: pointer;
    }
    .rgnf-panel input[type=range] { flex: 1; accent-color: var(--rgnf-accent); }
    .rgnf-val { min-width: 44px; text-align: right; color: var(--rgnf-accent); font-variant-numeric: tabular-nums; }
    .rgnf-chip {
      background: var(--rgnf-panel); border: 1px solid var(--rgnf-line); color: var(--rgnf-text);
      border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 12px;
    }
    .rgnf-chip.rgnf-on { border-color: var(--rgnf-accent); color: var(--rgnf-accent); box-shadow: 0 0 0 1px rgba(34,211,238,.25) inset; }
    .rgnf-stops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .rgnf-stop { position: relative; }
    .rgnf-stop button {
      position: absolute; top: -7px; right: -7px; width: 15px; height: 15px; border-radius: 50%;
      border: none; background: #ef4444; color: #fff; font-size: 9px; line-height: 1; cursor: pointer;
    }
    .rgnf-gradbar { height: 10px; border-radius: 6px; margin-top: 6px; border: 1px solid var(--rgnf-line); }
    .rgnf-sprites { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
    .rgnf-sprites button {
      background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 6px; padding: 3px 0; cursor: pointer; font-size: 15px; line-height: 1.2;
    }
    .rgnf-sprites button:hover { border-color: var(--rgnf-accent); transform: scale(1.1); }
    .rgnf-sprites button.rgnf-sprite-broken { opacity: .45; filter: grayscale(.6); }
    .rgnf-preview {
      background: radial-gradient(120% 140% at 50% 0%, #101a3a 0%, #070a16 70%);
      border: 1px solid var(--rgnf-line); border-radius: 12px; padding: 14px; text-align: center;
      min-height: 56px; display: flex; align-items: center; justify-content: center;
      /* sticky at top of scrollable body; must be a direct panel child */
      position: sticky; top: 0; z-index: 5;
      box-shadow: 0 6px 8px -6px rgba(0,0,0,0.6);
      margin-bottom: 8px;
    }
    .rgnf-preview-name { font-size: 18px; font-weight: 400; word-break: break-word; }
    .rgnf-preview-title { margin-top: 2px; }
    .rgnf-code {
      margin-top: 8px; background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 8px; padding: 8px; font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
      color: #9fb3ff; word-break: break-all; max-height: 90px; overflow-y: auto; user-select: all;
    }
    .rgnf-meta { display: flex; justify-content: space-between; color: var(--rgnf-muted); font-size: 11px; margin-top: 4px; }
    .rgnf-btn {
      border: none; border-radius: 10px; padding: 9px 12px; font-weight: 700; cursor: pointer; font-size: 13px;
      min-width: 0;
    }
    .rgnf-btn-apply {
      flex: 1; color: #06121a;
      background: linear-gradient(90deg, var(--rgnf-accent), var(--rgnf-accent-2));
    }
    .rgnf-btn-ghost { background: var(--rgnf-panel); color: var(--rgnf-text); border: 1px solid var(--rgnf-line); flex-shrink: 0; }
    /* wrap on narrow embeds so buttons stay on-screen */
    .rgnf-row { flex-wrap: wrap; }
    .rgnf-status { margin-top: 8px; font-size: 12px; min-height: 16px; }
    .rgnf-status.ok { color: #34d399; }
    .rgnf-status.err { color: #f87171; }
    .rgnf-presets { display: flex; flex-direction: column; gap: 6px; }
    .rgnf-preset { display: flex; align-items: center; gap: 6px; }
    .rgnf-preset span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rgnf-picker-backdrop {
      position: absolute; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
      background: rgba(4,6,12,.6); border-radius: 12px;
    }
    .rgnf-picker {
      width: 82%; max-width: 320px; background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.5);
    }
    .rgnf-picker-title { font-weight: 700; font-size: 13px; color: var(--rgnf-text); }
    .rgnf-picker-label { font-size: 11px; color: var(--rgnf-muted); margin-top: 2px; }
    .rgnf-picker-select, .rgnf-picker-input {
      width: 100%; box-sizing: border-box; background: var(--rgnf-bg); color: var(--rgnf-text);
      border: 1px solid var(--rgnf-line); border-radius: 8px; padding: 8px; font-size: 13px;
    }
  `;

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.appendChild(c);
    return node;
  }

  // inline styled overlay picker, not a native prompt. onPick gets
  // ({ name, folder }); name is '' when nameField is false.
  function openFolderPicker(panel, { title, existing, current, onPick, nameField = false, nameDefault = '', nameOnly = false }) {
    const backdrop = el('div', { class: 'rgnf-picker-backdrop' });
    const box = el('div', { class: 'rgnf-picker' });
    box.appendChild(el('div', { class: 'rgnf-picker-title', text: title }));

    // name field (Save / promote / rename)
    let nameInput = null;
    if (nameField) {
      if (!nameOnly) box.appendChild(el('div', { class: 'rgnf-picker-label', text: 'Name' }));
      nameInput = el('input', { type: 'text', class: 'rgnf-picker-input', value: nameDefault, placeholder: nameOnly ? 'Folder name' : 'Preset name' });
      box.appendChild(nameInput);
      if (!nameOnly) box.appendChild(el('div', { class: 'rgnf-picker-label', text: 'Folder' }));
    }

    // hidden entirely for name-only calls
    const sel = el('select', { class: 'rgnf-picker-select' });
    sel.appendChild(el('option', { value: '', text: '📂 Ungrouped' }));
    existing.filter(f => f && f !== 'Ungrouped').forEach(f => {
      const o = el('option', { value: f, text: '📁 ' + f });
      if (f === current) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    sel.appendChild(el('option', { value: '__new__', text: '➕ New folder…' }));
    if (!nameOnly) box.appendChild(sel);

    // shown when "New folder…" is picked
    const newWrap = el('div', { class: 'rgnf-row' });
    newWrap.style.display = 'none';
    const newInput = el('input', { type: 'text', placeholder: 'New folder name', class: 'rgnf-picker-input' });
    newWrap.appendChild(newInput);
    box.appendChild(newWrap);
    sel.addEventListener('change', () => {
      const isNew = sel.value === '__new__';
      newWrap.style.display = isNew ? 'flex' : 'none';
      if (isNew) newInput.focus();
    });

    const btnRow = el('div', { class: 'rgnf-row' });
    const close = () => backdrop.remove();
    btnRow.appendChild(el('button', {
      class: 'rgnf-chip', text: 'Cancel', onclick: close,
    }));
    btnRow.appendChild(el('button', {
      class: 'rgnf-chip rgnf-on', text: 'OK',
      onclick: () => {
        const folder = sel.value === '__new__' ? newInput.value.trim() : sel.value;
        const name = nameInput ? nameInput.value.trim() : '';
        if (nameField && !name) { nameInput.focus(); return; }
        close();
        onPick(nameField ? { name, folder } : folder);
        return;
      },
    }));
    box.appendChild(btnRow);

    backdrop.appendChild(box);
    (panel || document.body).appendChild(backdrop);
    (nameInput || sel).focus();
  }

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const fab = el('button', { class: 'rgnf-fab', title: 'Name Forge (Alt+N) — drag to move', text: '🎨' });
    const panel = el('div', { class: 'rgnf-panel' });


    const savedPos = loadJSON(FABPOS_KEY, null);
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      applyFabPos(fab, savedPos.left, savedPos.top);
    }

    // keep the FAB on-screen when the window shrinks
    window.addEventListener('resize', () => clampFab(fab));

    makeFabDraggable(fab, panel);

    fab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(fab, panel); }
    });

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyN' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // when embedded in ATLAS, route the shortcut through the HUD tab
        // (opening the flyout would yank it into a fixed overlay)
        if (_mountedIn) {
          const hudEl = document.getElementById('rgHUD');
          const bodyEl = document.getElementById('rgBody');
          const forgeView = document.getElementById('rgForgeView');
          if (hudEl) setAutoVisible(true);
          if (bodyEl) bodyEl.style.display = 'block';
          const minimize = document.getElementById('rgMinimize');
          if (minimize) {
            minimize.textContent = '–';
            minimize.title = 'Minimize';
          }
          if (!forgeView || forgeView.style.display === 'none') {
            document.getElementById('rgForgeBtn')?.click();
          }
          return;
        }
        togglePanel(fab, panel);
      }
    });
    document.body.appendChild(fab);
    document.body.appendChild(panel);
_rgnfFab = fab; _rgnfPanel = panel;
    fab.style.display = 'none'; // header 🎨 button replaces the floating bubble
    panel.style.display = 'none';
    clampFab(fab);

    render(panel);
  }

  // flips sides/vertical as needed to stay on-screen
  function positionPanel(fab, panel) {
    const f = fab.getBoundingClientRect();
    const gap = 12;
    const pw = 360;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    // left-align with FAB, flip if it would overflow the right edge
    let left = f.left;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, f.right - pw);
    // open upward, fall back to downward if there's no room
    const ph = Math.min(window.innerHeight * 0.78, 640);
    let top = f.top - gap - ph;
    if (top < 8) top = Math.min(window.innerHeight - ph - 8, f.bottom + gap);
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  function togglePanel(fab, panel) {
    const willOpen = !panel.classList.contains('rgnf-open');
    if (willOpen) positionPanel(fab, panel);
    panel.classList.toggle('rgnf-open');
  }

  function applyFabPos(fab, left, top) {
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
  }

  function clampFab(fab) {
    const r = fab.getBoundingClientRect();
    // still anchored via right/bottom (never moved) -> leave alone
    if (fab.style.left === '' || fab.style.left === 'auto') return;
    const maxLeft = window.innerWidth - r.width - 6;
    const maxTop = window.innerHeight - r.height - 6;
    const left = Math.max(6, Math.min(r.left, maxLeft));
    const top = Math.max(6, Math.min(r.top, maxTop));
    applyFabPos(fab, left, top);
  }

  function makeFabDraggable(fab, panel) {
    let sx, sy, ox, oy, dragging = false, moved = false;
    const DRAG_THRESHOLD = 4;

    const onDown = (e) => {
      const pt = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      const rect = fab.getBoundingClientRect();
      sx = pt.clientX; sy = pt.clientY; ox = rect.left; oy = rect.top;
      applyFabPos(fab, ox, oy); // switch from right/bottom anchoring to left/top
      fab.style.cursor = 'grabbing';
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      const dx = pt.clientX - sx, dy = pt.clientY - sy;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
      let left = ox + dx, top = oy + dy;
      const r = fab.getBoundingClientRect();
      left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
      top = Math.max(6, Math.min(top, window.innerHeight - r.height - 6));
      applyFabPos(fab, left, top);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      fab.style.cursor = 'pointer';
      const r = fab.getBoundingClientRect();
      if (moved) {
        saveJSON(FABPOS_KEY, { left: Math.round(r.left), top: Math.round(r.top) });
        // if the panel is open, keep it glued to the button's new spot
        if (panel.classList.contains('rgnf-open')) positionPanel(fab, panel);
      } else {
        togglePanel(fab, panel); // treat as a click
      }
    };

    fab.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    fab.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }


  // among-us role reveal on name steal. pointer-events:none + self-removal.
  function showImposterReveal(raw) {
    if (!document.getElementById('rgnfImposterKf')) {
      const st = document.createElement('style');
      st.id = 'rgnfImposterKf';
      st.textContent = '@keyframes rgnfImpIn { 0% { opacity:0; transform:scale(.6); letter-spacing:.45em; } 20% { opacity:1; transform:scale(1.06); letter-spacing:.1em; } 30% { transform:scale(1); } 84% { opacity:1; } 100% { opacity:0; } } '
        + '@keyframes rgnfImpBg { 0% { opacity:0; } 10% { opacity:1; } 84% { opacity:1; } 100% { opacity:0; } }';
      document.head.appendChild(st);
    }
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(4,6,12,.88);pointer-events:none;animation:rgnfImpBg 2.5s ease forwards;';
    const title = document.createElement('div');
    title.textContent = 'ඞ You are the Imposter';
    title.style.cssText = 'color:#ef4444;font:800 34px/1.2 -apple-system,"Segoe UI",Roboto,sans-serif;text-shadow:0 0 26px rgba(239,68,68,.85);animation:rgnfImpIn 2.5s ease forwards;';
    ov.appendChild(title);
    const sub = document.createElement('div');
    sub.style.cssText = 'margin-top:12px;font-size:18px;animation:rgnfImpIn 2.5s ease forwards;';
    sub.appendChild(renderRawTMP(raw));
    ov.appendChild(sub);
    document.body.appendChild(ov);
    setTimeout(() => ov.remove(), 2550);
  }

  function renderRawTMP(raw) {
    const root = document.createElement('div');
    root.style.lineHeight = '1.35';
    const st = { color: null, bold: false, italic: false, sub: false, sizePct: 100, rotate: 0, mark: null };
    let line = document.createElement('div');
    root.appendChild(line);
    let i = 0;
    const spriteEmoji = n => (SPRITES.find(x => x.n === n) || {}).e || '❔';
    while (i < raw.length) {
      const rest = raw.slice(i);
      let m;
      if ((m = rest.match(/^<br\s*\/?\s*>/i))) { line = document.createElement('div'); root.appendChild(line); i += m[0].length; continue; }
      if ((m = rest.match(/^<(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)>/))) { st.color = m[1]; i += m[0].length; continue; }
      if ((m = rest.match(/^<b>/i)))   { st.bold = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/b>/i))) { st.bold = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<i>/i)))   { st.italic = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/i>/i))) { st.italic = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<sub>/i)))   { st.sub = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/sub>/i))) { st.sub = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<size=(\d+)%?>/i))) { st.sizePct = Number(m[1]) || 100; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/size>/i))) { st.sizePct = 100; i += m[0].length; continue; }
      if ((m = rest.match(/^<rotate=(-?\d+)>/i))) { st.rotate = Number(m[1]) || 0; i += m[0].length; continue; }
      if ((m = rest.match(/^<mark=(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)>/i))) { st.mark = m[1]; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/mark>/i))) { st.mark = null; i += m[0].length; continue; }
      if ((m = rest.match(/^<sprite=(\d+)>/i))) {
        const sp = document.createElement('span');
        sp.textContent = spriteEmoji(Number(m[1]));
        line.appendChild(sp); i += m[0].length; continue;
      }
      if ((m = rest.match(/^<[^>]*>/))) { i += m[0].length; continue; } // unknown tag
      const ch = raw[i];
      const span = document.createElement('span');
      span.textContent = ch;
      if (st.color) span.style.color = st.color;
      if (st.bold) span.style.fontWeight = '700';
      if (st.italic) span.style.fontStyle = 'italic';
      if (st.mark) span.style.background = st.mark;
      let size = 18 * (st.sizePct / 100);
      if (st.sub) { size *= 0.65; span.style.verticalAlign = 'sub'; }
      span.style.fontSize = Math.max(7, size) + 'px';
      if (st.rotate) { span.style.display = 'inline-block'; span.style.transform = 'rotate(' + st.rotate + 'deg)'; }
      line.appendChild(span);
      i++;
    }
    return root;
  }

  function render(panel) {
    panel.innerHTML = '';
    saveJSON(stateKey(), state);

    // ---- header (draggable in fly-out mode; inert inside HUD tab) ----
    const head = el('div', { class: 'rgnf-head' }, [
      el('b', { text: 'Name Forge' }),
    ]);
    makeDraggable(panel, head);
    panel.appendChild(head);

    // touch-to-exit raw mode. wired once, fires only on real user input.
    // touching a styling control clears the raw snapshot so its handler wins.
    if (!panel._rgnfRawExitWired) {
      panel._rgnfRawExitWired = true;
      const exitRawIfStylingTouch = (e) => {
        if (!state.rawCode) return;
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('.rgnf-modebar') || t.closest('.rgnf-actions-sec')
            || t.closest('.rgnf-preview-sec') || t.closest('.rgnf-preview')
            || t.closest('.rgnf-presets-sec') || t.closest('.rgnf-imposter-sec')
            || t.closest('.rgnf-head')) return;
        state.rawCode = null;
        saveJSON(stateKey(), state);
        const bar = panel.querySelector('.rgnf-modebar');
        if (bar) bar.remove();
      };
      panel.addEventListener('pointerdown', exitRawIfStylingTouch, true);
      panel.addEventListener('keydown', exitRawIfStylingTouch, true);
    }

    // ---- preview + code ----
    // preview goes directly on the panel so sticky's parent is the full
    // scrollable body. header/code/meta stay in secPreview and scroll.
    const pv = el('div', { class: 'rgnf-preview' });
    pv.appendChild(renderPreview(state));
    panel.appendChild(pv);

    const secPreview = el('div', { class: 'rgnf-sec rgnf-preview-sec' });
    // "Preview" label + ↺ reset to the current in-game name
    {
      const hrow = el('div', {});
      hrow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';
      const h4 = el('h4', { text: 'Preview' });
      h4.style.margin = '0';
      hrow.appendChild(h4);
      if (_lastRawNickname) {
        hrow.appendChild(el('button', {
          class: 'rgnf-chip', text: '↺',
          title: 'Reset to my current in-game name',
          onclick: () => { state.rawCode = _lastRawNickname; render(panel); },
        }));
      }
      secPreview.appendChild(hrow);
    }
    // hand-editing either mode captures the text as rawCode and flips to raw
    // so subsequent rebuilds don't clobber the edit
    const rawEdit = el('textarea', { class: 'rgnf-code' });
    rawEdit.style.cssText = 'display:block;width:100%;box-sizing:border-box;min-height:34px;resize:none;overflow:hidden;background:var(--rgnf-panel);border:1px solid var(--rgnf-line);border-radius:8px;padding:8px;font:11px/1.5 ui-monospace, Menlo, Consolas, monospace;color:#9fb3ff;';
    // reset to auto first, scrollHeight won't shrink below the current height
    const autosizeRawEdit = () => {
      rawEdit.style.height = 'auto';
      rawEdit.style.height = (rawEdit.scrollHeight + 2) + 'px';
    };
    rawEdit.addEventListener('input', () => {
      autosizeRawEdit();
      // capturing text as rawCode flips us into raw mode (refreshPreview keys off it)
      state.rawCode = rawEdit.value;
      const rawPfx = _prefix();
      pv.replaceChildren(renderRawTMP(rawPfx + state.rawCode));
      charSpan.textContent = `${(rawPfx + state.rawCode).length} chars`;
      const plainLetters = state.rawCode.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
      letterSpan.textContent = `${[...plainLetters].length} letters`;
      saveJSON(stateKey(), state);
    });
    secPreview.appendChild(rawEdit);
    const charSpan = el('span', { text: '' });
    const letterSpan = el('span', { text: '' });
    secPreview.appendChild(el('div', { class: 'rgnf-meta' }, [charSpan, letterSpan]));
    panel.appendChild(secPreview);

    // update preview/code/meta without rebuilding the panel, so the name field
    // keeps focus and cursor position while typing
    const refreshPreview = () => {
      if (state.rawCode) {
        // clan-tag prefix applies in raw mode too. old hardcoded tags in the raw
        // name will preview doubled, fix by deleting them in the textarea.
        const rawPfx = _prefix();
        pv.replaceChildren(renderRawTMP(rawPfx + state.rawCode));
        if (rawEdit.value !== state.rawCode) rawEdit.value = state.rawCode;
        autosizeRawEdit();
        charSpan.textContent = `${(rawPfx + state.rawCode).length} chars`;
        const plainLetters = state.rawCode.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
        letterSpan.textContent = `${[...plainLetters].length} letters`;
        saveJSON(stateKey(), state);
        return;
      }
      // rebuild mode: store without the prefix so a subsequent hand-edit's
      // rawCode capture has no baked-in tag
      const built = buildCode(state);
      const code = _prefix() + built;
      pv.replaceChildren(renderPreview(state));
      if (rawEdit.value !== built) rawEdit.value = built;
      autosizeRawEdit();
      charSpan.textContent = `${code.length} chars`;
      letterSpan.textContent = `${[...state.name].length} letters`;
      saveJSON(stateKey(), state);
    };
    refreshPreview();

    // ---- Name ----
    const secName = el('div', { class: 'rgnf-sec' });
    secName.appendChild(el('h4', { text: 'Name' }));
    const nameInput = el('input', {
      type: 'text', value: state.name,
      placeholder: 'Type your name…',
      oninput: (e) => { state.name = e.target.value; refreshPreview(); },
    });
    secName.appendChild(el('div', { class: 'rgnf-row' }, [
      nameInput,
      el('button', {
        class: 'rgnf-chip', text: '✕ Clear', title: 'Clear the name field',
        onclick: () => { state.name = ''; nameInput.value = ''; refreshPreview(); nameInput.focus(); },
      }),
    ]));

    // sprite inserter
    secName.appendChild(el('h4', { text: 'Insert emoji sprite (0–15)' }));
    const spriteGrid = el('div', { class: 'rgnf-sprites' });
    SPRITES.forEach((sp) => {
      const btn = el('button', {
        text: sp.e,
        title: `${sp.n}: ${sp.label} — <sprite=${sp.n}>`,
        onclick: () => {
          const tag = `<sprite=${sp.n}>`;
          const start = nameInput.selectionStart ?? state.name.length;
          const end = nameInput.selectionEnd ?? state.name.length;
          state.name = state.name.slice(0, start) + tag + state.name.slice(end);
          nameInput.value = state.name;
          const pos = start + tag.length;
          nameInput.focus();
          nameInput.setSelectionRange(pos, pos);
          refreshPreview();
        },
      });
      if (sp.broken) btn.classList.add('rgnf-sprite-broken');
      spriteGrid.appendChild(btn);
    });
    secName.appendChild(spriteGrid);
    panel.appendChild(secName);

    // ---- Color ----
    const secColor = el('div', { class: 'rgnf-sec' });
    secColor.appendChild(el('h4', { text: 'Color' }));
    const modeRow = el('div', { class: 'rgnf-row' });
    ['none', 'solid', 'gradient'].forEach((m) => {
      modeRow.appendChild(el('button', {
        class: `rgnf-chip ${state.colorMode === m ? 'rgnf-on' : ''}`,
        text: m[0].toUpperCase() + m.slice(1),
        onclick: () => { state.colorMode = m; render(panel); },
      }));
    });
    secColor.appendChild(modeRow);

    if (state.colorMode === 'solid') {
      secColor.appendChild(el('div', { class: 'rgnf-row' }, [
        el('label', { text: 'Color' }),
        el('input', { type: 'color', value: state.solidColor, oninput: (e) => { state.solidColor = e.target.value; render(panel); } }),
        el('label', { text: 'Opacity' }, [
          el('input', { type: 'range', min: 32, max: 255, value: state.solidAlpha ?? 255,
            oninput: (e) => { state.solidAlpha = Number(e.target.value); refreshPreview(); },
            style: 'width:80px;margin-left:6px;',
          }),
        ]),
      ]));
    }

    if (state.colorMode === 'gradient') {
      const stopsWrap = el('div', { class: 'rgnf-stops' });
      state.stops.forEach((c, idx) => {
        const stop = el('div', { class: 'rgnf-stop' }, [
          el('input', { type: 'color', value: c, oninput: (e) => { state.stops[idx] = e.target.value; render(panel); } }),
        ]);
        if (state.stops.length > 2) {
          stop.appendChild(el('button', { text: '✕', onclick: () => { state.stops.splice(idx, 1); render(panel); } }));
        }
        stopsWrap.appendChild(stop);
      });
      if (state.stops.length < 5) {
        stopsWrap.appendChild(el('button', {
          class: 'rgnf-chip', text: '+ stop',
          onclick: () => { state.stops.push(state.stops[state.stops.length - 1]); render(panel); },
        }));
      }
      secColor.appendChild(stopsWrap);
      const bar = el('div', { class: 'rgnf-gradbar' });
      bar.style.background = `linear-gradient(90deg, ${state.stops.join(',')})`;
      secColor.appendChild(bar);

      // one-click palettes + tools
      const palRow = el('div', { class: 'rgnf-row' });
      PALETTES.forEach((p) => {
        palRow.appendChild(el('button', {
          class: 'rgnf-chip', text: p.label, title: p.stops.join(' → '),
          onclick: () => { state.stops = [...p.stops]; render(panel); },
        }));
      });
      palRow.appendChild(el('button', {
        class: 'rgnf-chip', text: '⇄ Reverse', title: 'Flip gradient direction',
        onclick: () => { state.stops.reverse(); render(panel); },
      }));
      palRow.appendChild(el('button', {
        class: 'rgnf-chip', text: '🎲 Random', title: 'Roll a random vivid gradient',
        onclick: () => { state.stops = randomStops(); render(panel); },
      }));
      secColor.appendChild(palRow);

      secColor.appendChild(el('div', { class: 'rgnf-row' }, [
        el('button', {
          class: `rgnf-chip ${state.skipSpaces ? 'rgnf-on' : ''}`,
          text: 'Skip spaces (fewer tags)',
          onclick: () => { state.skipSpaces = !state.skipSpaces; render(panel); },
        }),
      ]));
    }
    panel.appendChild(secColor);

    // ---- Styles ----
    const secStyle = el('div', { class: 'rgnf-sec' });
    secStyle.appendChild(el('h4', { text: 'Style' }));
    const styleRow = el('div', { class: 'rgnf-row' });
    const toggles = [['bold', 'B'], ['italic', 'I'], ['underline', 'U'], ['strike', 'S']];
    toggles.forEach(([key, label]) => {
      styleRow.appendChild(el('button', {
        class: `rgnf-chip ${state[key] ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state[key] = !state[key]; render(panel); },
      }));
    });
    secStyle.appendChild(styleRow);

    secStyle.appendChild(sliderRow(panel, 'Size', 'sizePct', 10, 500, '%'));
    secStyle.appendChild(sliderRow(panel, 'Rotate', 'rotateDeg', -45, 45, '°'));

    const waveRow = el('div', { class: 'rgnf-row' });
    waveRow.appendChild(el('button', {
      class: `rgnf-chip ${state.waveOn ? 'rgnf-on' : ''}`,
      text: '〰 Wave letters',
      title: 'Alternates each letter\'s tilt — overrides Rotate while on',
      onclick: () => { state.waveOn = !state.waveOn; render(panel); },
    }));
    secStyle.appendChild(waveRow);
    if (state.waveOn) {
      secStyle.appendChild(sliderRow(panel, 'Tilt', 'waveAmp', 3, 35, '°'));
    }

    const markRow = el('div', { class: 'rgnf-row' });
    markRow.appendChild(el('button', {
      class: `rgnf-chip ${state.markOn ? 'rgnf-on' : ''}`, text: 'Highlight',
      onclick: () => { state.markOn = !state.markOn; render(panel); },
    }));
    if (state.markOn) {
      markRow.appendChild(el('input', { type: 'color', value: state.markColor, oninput: (e) => { state.markColor = e.target.value; render(panel); } }));
      markRow.appendChild(el('input', {
        type: 'range', min: 16, max: 255, value: state.markAlpha,
        oninput: (e) => { state.markAlpha = Number(e.target.value); render(panel); },
      }));
    }
    secStyle.appendChild(markRow);
    panel.appendChild(secStyle);

    // ---- Title ----
    const secTitle = el('div', { class: 'rgnf-sec' });
    secTitle.appendChild(el('h4', { text: 'Title (line under name)' }));
    const tRow = el('div', { class: 'rgnf-row' });
    tRow.appendChild(el('button', {
      class: `rgnf-chip ${state.titleOn ? 'rgnf-on' : ''}`, text: state.titleOn ? 'On' : 'Off',
      onclick: () => { state.titleOn = !state.titleOn; render(panel); },
    }));
    secTitle.appendChild(tRow);
    if (state.titleOn) {
      // text input
      secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
        el('input', { type: 'text', placeholder: 'e.g. RGC FINALIST', value: state.titleText, oninput: (e) => { state.titleText = e.target.value; refreshPreview(); } }),
      ]));
      // color mode
      const tm = el('div', { class: 'rgnf-row' });
      [['inherit', 'Inherit'], ['solid', 'Solid'], ['gradient', 'Gradient']].forEach(([v, label]) => {
        tm.appendChild(el('button', {
          class: `rgnf-chip ${state.titleColorMode === v ? 'rgnf-on' : ''}`, text: label,
          onclick: () => { state.titleColorMode = v; render(panel); },
        }));
      });
      secTitle.appendChild(tm);
      // opacity is below, applies to solid AND gradient
      if (state.titleColorMode === 'solid') {
        secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
          el('input', { type: 'color', value: state.titleColor, oninput: (e) => { state.titleColor = e.target.value; refreshPreview(); } }),
        ]));
      }
      // own palettes + stops (mirrors Name gradient)
      if (state.titleColorMode === 'gradient') {
        const palRow = el('div', { class: 'rgnf-row' });
        PALETTES.forEach(p => {
          palRow.appendChild(el('button', {
            class: `rgnf-chip ${state.titlePaletteKey === p.label ? 'rgnf-on' : ''}`, text: p.label,
            onclick: () => {
              state.titlePaletteKey = p.label;
              state.titleStops = [...p.stops];
              refreshPreview();
              render(panel);
            },
          }));
        });
        secTitle.appendChild(palRow);
        const tStops = el('div', { class: 'rgnf-row' });
        state.titleStops.forEach((c, idx) => {
          const stop = el('div', { class: 'rgnf-stop' }, [
            el('input', { type: 'color', value: c, oninput: (e) => {
              state.titleStops[idx] = e.target.value;
              state.titlePaletteKey = null;
              refreshPreview();
              // repaint gradient bar
              const bar = document.getElementById('rgnfTitleGradBar');
              if (bar) bar.style.background = `linear-gradient(90deg, ${state.titleStops.join(',')})`;
            } }),
          ]);
          if (state.titleStops.length > 2) {
            stop.appendChild(el('button', { text: '✕', onclick: () => { state.titleStops.splice(idx, 1); state.titlePaletteKey = null; render(panel); } }));
          }
          tStops.appendChild(stop);
        });
        if (state.titleStops.length < 5) {
          tStops.appendChild(el('button', {
            class: 'rgnf-chip', text: '+ stop',
            onclick: () => { state.titleStops.push(state.titleStops[state.titleStops.length - 1]); state.titlePaletteKey = null; render(panel); },
          }));
        }
        secTitle.appendChild(tStops);
        const bar = el('div', { class: 'rgnf-gradbar' });
        bar.id = 'rgnfTitleGradBar';
        bar.style.background = `linear-gradient(90deg, ${state.titleStops.join(',')})`;
        secTitle.appendChild(bar);
      }
      // opacity applies to solid AND gradient via 8-digit hex
      if (state.titleColorMode !== 'inherit') {
        secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
          el('label', { text: 'Opacity' }, [
            el('input', { type: 'range', min: 32, max: 255, value: state.titleAlpha ?? 255,
              oninput: (e) => { state.titleAlpha = Number(e.target.value); refreshPreview(); },
              style: 'width:140px;margin-left:6px;',
            }),
          ]),
        ]));
      }
      secTitle.appendChild(sliderRow(panel, 'Size', 'titleSizePct', 10, 500, '%'));
      const tStyle = el('div', { class: 'rgnf-row' });
      const tToggle = (key, label) => el('button', {
        class: `rgnf-chip ${state[key] ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state[key] = !state[key]; refreshPreview(); render(panel); },
      });
      tStyle.appendChild(tToggle('titleBold', 'B'));
      tStyle.appendChild(tToggle('titleItalic', 'I'));
      tStyle.appendChild(tToggle('titleUnderline', 'U'));
      tStyle.appendChild(tToggle('titleStrike', 'S'));
      tStyle.appendChild(tToggle('titleSub', '<sub>'));
      secTitle.appendChild(tStyle);
    }
    panel.appendChild(secTitle);

    // ---- Scored! ----
    const secScored = el('div', { class: 'rgnf-sec' });
    secScored.appendChild(el('h4', { text: '"Scored!" text' }));
    const sRow = el('div', { class: 'rgnf-row' });
    [['default', 'Default'], ['hide', 'Hide'], ['tiny', 'Tiny'], ['styled', 'Styled']].forEach(([v, label]) => {
      sRow.appendChild(el('button', {
        class: `rgnf-chip ${state.scoredMode === v ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state.scoredMode = v; render(panel); },
      }));
    });
    secScored.appendChild(sRow);
    if (state.scoredMode === 'styled') {
      secScored.appendChild(el('div', { class: 'rgnf-row' }, [
        el('label', { text: 'Color' }),
        el('input', { type: 'color', value: state.scoredColor, oninput: (e) => { state.scoredColor = e.target.value; render(panel); } }),
      ]));
      secScored.appendChild(sliderRow(panel, 'Size', 'scoredSizePct', 10, 300, '%'));
    }
    panel.appendChild(secScored);

    // ---- imposter ----
    // captured lobby names, rendered with their exact markup. rgnf-imposter-sec
    // marker excludes this from the raw-mode touch-to-exit listener.
    const secImposter = el('div', { class: 'rgnf-sec rgnf-imposter-sec' });
    secImposter.appendChild(el('h4', { text: 'ඞ Imposter (last game lobby)' }));
    const roster = _roster();
    if (!roster.length) {
      const hint = el('div', { text: 'Finish a match and the crew from that lobby shows up here. The Imposter could be anyone... even you. ඞ' });
      hint.style.cssText = 'color:var(--rgnf-muted);font-size:12px;';
      secImposter.appendChild(hint);
    } else {
      // preview shows a stolen name -> flag it
      if (state.rawCode && roster.includes(state.rawCode)) {
        const reveal = el('div', { text: 'You are the Imposter. ඞ' });
        reveal.style.cssText = 'color:#ef4444;font-size:12px;font-weight:700;margin-bottom:6px;';
        secImposter.appendChild(reveal);
      }
      const rosterWrap = el('div', { class: 'rgnf-presets' });
      roster.slice(0, 8).forEach((raw) => {
        const row = el('div', { class: 'rgnf-preset' });
        const nameCell = el('span', { title: raw });
        // capped height so multi-line titles can't blow up the row
        nameCell.style.cssText = 'flex:1;overflow:hidden;max-height:44px;white-space:normal;';
        nameCell.appendChild(renderRawTMP(raw));
        row.appendChild(nameCell);
        row.appendChild(el('button', {
          class: 'rgnf-chip', text: 'ඞ Steal',
          title: 'Steal AND apply instantly',
          onclick: async (e) => {
            const b = e.currentTarget;
            b.textContent = '…';
            b.disabled = true;
            try {
              // one-click: apply first, reveal over a name that's already live
              const codeApplied = _prefix() + raw;
              const r = await applyNickname(codeApplied);
              if (r.ok) {
                state.rawCode = raw;
                _lastRawNickname = raw;
                const hist = loadJSON(HISTORY_KEY, []);
                const plain = raw.replace(/<[^>]*>/g, '').trim().slice(0, 24) || '(markup only)';
                hist.unshift({ code: codeApplied, plain, ts: Date.now() });
                saveJSON(HISTORY_KEY, hist.slice(0, 5));
                // both forms, login nicknames come back clan-tag-stripped
                saveJSON(pendingStealKey(), { code: codeApplied, body: raw, ts: Date.now() });
                render(panel);
                showImposterReveal(raw);
                // silent re-apply, a race sometimes needed a second push
                setTimeout(() => { applyNickname(codeApplied).catch(() => {}); }, 1000);
                return;
              }
              b.textContent = '✗';
            } catch (err) { b.textContent = '✗'; }
            b.disabled = false;
            setTimeout(() => { b.textContent = 'ඞ Steal'; }, 1500);
          },
        }));
        rosterWrap.appendChild(row);
      });
      secImposter.appendChild(rosterWrap);
    }
    panel.appendChild(secImposter);

    // ---- presets ----
    // rgnf-presets-sec: excluded from the raw-mode touch-to-exit listener.
    // otherwise "+ Save" in raw mode cleared rawCode before the save ran.
    const secPresets = el('div', { class: 'rgnf-sec rgnf-presets-sec' });
    secPresets.appendChild(el('h4', { text: 'Presets' }));
    const presets = loadJSON(STORE_KEY, []);
    const listWrap = el('div', { class: 'rgnf-presets' });

    // presets with no folder -> "Ungrouped"
    const collapseKey = 'rgNameForge.folderCollapse.v1';
    const collapseState = loadJSON(collapseKey, {});
    const groups = {};
    presets.forEach((p, idx) => {
      const f = (p.folder && String(p.folder).trim()) || 'Ungrouped';
      (groups[f] = groups[f] || []).push({ p, idx });
    });
    // alphabetical, Ungrouped last
    const folderNames = Object.keys(groups).sort((a, b) => {
      if (a === 'Ungrouped') return 1;
      if (b === 'Ungrouped') return -1;
      return a.localeCompare(b);
    });

    folderNames.forEach((folder) => {
      const collapsed = collapseState[folder] === true;
      const header = el('div', { class: 'rgnf-row' });
      header.style.cssText = 'user-select:none;align-items:center;gap:6px;font-weight:600;';
      const label = el('span', { text: (collapsed ? '▸' : '▾') + ' 📁 ' + folder + ` (${groups[folder].length})` });
      label.style.cssText = 'cursor:pointer;flex:1;';
      label.onclick = () => {
        collapseState[folder] = !collapsed;
        saveJSON(collapseKey, collapseState);
        render(panel);
      };
      header.appendChild(label);
      // "Ungrouped" is synthetic, nothing to rename
      if (folder !== 'Ungrouped') {
        header.appendChild(el('button', {
          class: 'rgnf-chip', text: '✏️', title: 'Rename folder',
          onclick: () => {
            openFolderPicker(panel, {
              title: 'Rename folder "' + folder + '"',
              nameField: true,
              nameOnly: true,
              nameDefault: folder,
              existing: [],
              current: '',
              onPick: ({ name: newName }) => {
                const nn = (newName || '').trim();
                if (!nn || nn === folder) return;
                presets.forEach(pr => { if ((pr.folder || 'Ungrouped') === folder) pr.folder = nn; });
                if (collapseState[folder] !== undefined) {
                  collapseState[nn] = collapseState[folder];
                  delete collapseState[folder];
                  saveJSON(collapseKey, collapseState);
                }
                saveJSON(STORE_KEY, presets);
                render(panel);
              },
            });
          },
        }));
        // no "delete folder", folders are derived from membership
      }
      listWrap.appendChild(header);

      if (!collapsed) {
        groups[folder].forEach(({ p, idx }) => {
          const row = el('div', { class: 'rgnf-preset' });
          row.style.marginLeft = '10px';
          row.appendChild(el('span', { text: p.label }));
          row.appendChild(el('button', { class: 'rgnf-chip', text: 'Load', onclick: () => { state = Object.assign(defaultState(), p.state); render(panel); } }));
          row.appendChild(el('button', {
            class: 'rgnf-chip', text: '📁', title: 'Move to folder',
            onclick: () => {
              openFolderPicker(panel, {
                title: 'Move "' + p.label + '" to folder',
                existing: folderNames,
                current: p.folder || '',
                onPick: (dest) => {
                  presets[idx].folder = dest || undefined;
                  saveJSON(STORE_KEY, presets);
                  render(panel);
                },
              });
            },
          }));
          row.appendChild(el('button', {
            class: 'rgnf-chip', text: '🗑️', title: 'Delete preset',
            onclick: () => { presets.splice(idx, 1); saveJSON(STORE_KEY, presets); render(panel); },
          }));
          listWrap.appendChild(row);
        });
      }
    });

    listWrap.appendChild(el('button', {
      class: 'rgnf-chip', text: '+ Save current as preset',
      onclick: () => {
        const snap = JSON.parse(JSON.stringify(state));
        const defaultName = state.name.replace(/<[^>]*>/g, '').slice(0, 30) || 'Preset';
        openFolderPicker(panel, {
          title: 'Save preset',
          nameField: true,
          nameDefault: defaultName,
          existing: folderNames,
          current: '',
          onPick: ({ name: label, folder }) => {
            if (!label) return;
            const entry = { label, state: snap };
            if (folder) entry.folder = folder;
            const existingIdx = presets.findIndex(x => x.label === label);
            if (existingIdx >= 0) {
              const replace = confirm('A preset named "' + label + '" already exists.\nOK = replace it, Cancel = keep both.');
              if (replace) presets[existingIdx] = entry;
              else { entry.label = label + ' (2)'; presets.push(entry); }
            } else {
              presets.push(entry);
            }
            saveJSON(STORE_KEY, presets);
            render(panel);
          },
        });
      },
    }));
    secPresets.appendChild(listWrap);

    // export/import for sharing
    secPresets.appendChild(el('div', { class: 'rgnf-row' }, [
      el('button', {
        class: 'rgnf-chip', text: '📤 Export', title: 'Copy all presets as JSON to share',
        onclick: async (e) => {
          const b = e.currentTarget;
          try {
            await navigator.clipboard.writeText(JSON.stringify(presets));
            b.textContent = 'Copied ✓';
          } catch (err) { b.textContent = 'Failed'; }
          setTimeout(() => { b.textContent = '📤 Export'; }, 1200);
        },
      }),
      el('button', {
        class: 'rgnf-chip', text: '📥 Import', title: 'Paste preset JSON from a friend',
        onclick: () => {
          const raw = prompt('Paste preset JSON:');
          if (!raw) return;
          try {
            const incoming = JSON.parse(raw);
            if (!Array.isArray(incoming)) throw new Error('not an array');
            const merged = presets.concat(incoming.filter(p => p && p.label && p.state));
            saveJSON(STORE_KEY, merged);
            render(panel);
          } catch (err) {
            alert('That JSON was as valid as a screen-door submarine. Import failed.');
          }
        },
      }),
    ]));

    // last 5 applies. 💾 promotes to a permanent preset before it rotates out.
    const hist = loadJSON(HISTORY_KEY, []);
    if (hist.length) {
      secPresets.appendChild(el('h4', { text: 'Recently applied (auto — newest 5 only)' }));
      const histWrap = el('div', { class: 'rgnf-presets' });
      hist.forEach((h) => {
        histWrap.appendChild(el('div', { class: 'rgnf-preset' }, [
          el('span', { text: h.plain, title: h.code }),
          el('button', {
            class: 'rgnf-chip', text: '💾', title: 'Save this as a permanent preset',
            onclick: () => {
              // strip the clan-tag prefix, the checkbox owns it
              let code = h.code;
              const pfx = _prefix();
              if (pfx && code.startsWith(pfx)) code = code.slice(pfx.length);
              const snap = Object.assign(defaultState(), { rawCode: code });
              openFolderPicker(panel, {
                title: 'Save preset',
                nameField: true,
                nameDefault: h.plain.slice(0, 30) || 'Preset',
                existing: folderNames,
                current: '',
                onPick: ({ name: label, folder }) => {
                  if (!label) return;
                  const entry = { label, state: snap };
                  if (folder) entry.folder = folder;
                  const existingIdx = presets.findIndex(x => x.label === label);
                  if (existingIdx >= 0) {
                    const replace = confirm('A preset named "' + label + '" already exists.\nOK = replace it, Cancel = keep both.');
                    if (replace) presets[existingIdx] = entry;
                    else { entry.label = label + ' (2)'; presets.push(entry); }
                  } else {
                    presets.push(entry);
                  }
                  saveJSON(STORE_KEY, presets);
                  render(panel);
                },
              });
            },
          }),
          el('button', {
            class: 'rgnf-chip', text: 'Re-apply',
            onclick: async (e) => {
              const b = e.currentTarget;
              b.textContent = '…';
              try {
                const r = await applyNickname(h.code);
                if (r.ok) {
                  // load what was applied into preview so the screen matches live
                  let code = h.code;
                  const pfx = _prefix();
                  if (pfx && code.startsWith(pfx)) code = code.slice(pfx.length);
                  state.rawCode = code;
                  _lastRawNickname = code;
                  render(panel);
                  return;
                }
                b.textContent = '✗';
              } catch (err) { b.textContent = '✗'; }
              setTimeout(() => { b.textContent = 'Re-apply'; }, 1500);
            },
          }),
        ]));
      });
      histWrap.appendChild(el('button', {
        class: 'rgnf-chip', text: 'Clear history',
        onclick: () => { saveJSON(HISTORY_KEY, []); render(panel); },
      }));
      secPresets.appendChild(histWrap);
    }
    panel.appendChild(secPresets);

    // ---- Actions ----
    const secActions = el('div', { class: 'rgnf-sec rgnf-actions-sec' });
    const statusLine = el('div', { class: 'rgnf-status' });
    const applyBtn = el('button', {
      class: 'rgnf-btn rgnf-btn-apply', text: 'Apply nickname',
      onclick: async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying…';
        statusLine.className = 'rgnf-status';
        statusLine.textContent = '';
        try {
          const codeApplied = _prefix() + (state.rawCode ? state.rawCode : buildCode(state));
          // reset target is unprefixed, checkbox owns the tag (double-tag fix)
          _lastRawNickname = state.rawCode ? state.rawCode : buildCode(state);
          const result = await applyNickname(codeApplied);
          if (result.ok) {
            statusLine.className = 'rgnf-status ok';
            statusLine.textContent = '✓ Nickname updated';
            const hist = loadJSON(HISTORY_KEY, []);
            const plain = state.name.replace(/<[^>]*>/g, '').slice(0, 24) || '(sprites only)';
            hist.unshift({ code: codeApplied, plain, ts: Date.now() });
            saveJSON(HISTORY_KEY, hist.slice(0, 5));
          } else {
            statusLine.className = 'rgnf-status err';
            statusLine.textContent = `✗ ${result.status}: ${result.body.slice(0, 120)}`;
          }
        } catch (e) {
          statusLine.className = 'rgnf-status err';
          statusLine.textContent = `✗ ${e.message}`;
        } finally {
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply nickname';
        }
      },
    });
    const copyBtn = el('button', {
      class: 'rgnf-btn rgnf-btn-ghost', text: 'Copy code',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(_prefix() + (state.rawCode ? state.rawCode : buildCode(state)));
          copyBtn.textContent = 'Copied ✓';
          setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1200);
        } catch (e) {
          copyBtn.textContent = 'Copy failed';
          setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1200);
        }
      },
    });
    secActions.appendChild(el('div', { class: 'rgnf-row' }, [applyBtn, copyBtn]));
    secActions.appendChild(statusLine);
    panel.appendChild(secActions);
  }

  function sliderRow(panel, label, key, min, max, unit) {
    const row = el('div', { class: 'rgnf-row' });
    row.appendChild(el('label', { text: label }));
    row.appendChild(el('input', {
      type: 'range', min, max, value: state[key],
      oninput: (e) => {
        state[key] = Number(e.target.value);
        row.querySelector('.rgnf-val').textContent = state[key] + unit;
      },
      onchange: () => render(panel),
    }));
    row.appendChild(el('span', { class: 'rgnf-val', text: state[key] + unit }));
    return row;
  }

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // ------------------------------------------------------------------
  // Input capture guard, MUST register before the game's handlers.
  // rocketgoal.io binds control keys at window capture and preventDefaults them.
  // we run at document-start, register first, and stopImmediatePropagation for
  // events aimed at our UI so the game never sees them.
  // ------------------------------------------------------------------
  function installInputGuard() {
    const inUI = (t) => t && t.closest && (t.closest('.rgnf-panel') || t.closest('.rgnf-fab'));
    const isTextField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

    // we take over editing for our own fields, mutate value ourselves and fire
    // a synthetic input event. works no matter what the game does with the key.
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!inUI(t)) return;
      if (e.altKey && e.code === 'KeyN') return; // let the global toggle through

      // always hide the event from the game's global handlers
      e.stopImmediatePropagation();

      if (!isTextField(t) || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;

      const start = t.selectionStart ?? t.value.length;
      const end = t.selectionEnd ?? t.value.length;
      let handled = false;

      if (e.key.length === 1) {
        // printable char (browser already handled shift/case)
        t.value = t.value.slice(0, start) + e.key + t.value.slice(end);
        const p = start + 1; t.setSelectionRange(p, p); handled = true;
      } else if (e.key === 'Backspace') {
        if (start !== end) { t.value = t.value.slice(0, start) + t.value.slice(end); t.setSelectionRange(start, start); }
        else if (start > 0) { t.value = t.value.slice(0, start - 1) + t.value.slice(end); t.setSelectionRange(start - 1, start - 1); }
        handled = true;
      } else if (e.key === 'Delete') {
        if (start !== end) { t.value = t.value.slice(0, start) + t.value.slice(end); t.setSelectionRange(start, start); }
        else { t.value = t.value.slice(0, start) + t.value.slice(end + 1); t.setSelectionRange(start, start); }
        handled = true;
      }
      // arrows/home/end/tab fall through, browser caret still works
      if (handled) {
        e.preventDefault();
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, true);

    // keep keyup/keypress away from the game too
    ['keyup', 'keypress'].forEach((evt) => {
      window.addEventListener(evt, (e) => {
        const t = e.target;
        if (!inUI(t)) return;
        if (e.altKey && e.code === 'KeyN') return;
        e.stopImmediatePropagation();
      }, true);
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  installInputGuard();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
      let _mountedIn = null;
      // HUD sets this to getClanTagPrefix so Forge stays clan-agnostic
      let _prefixProvider = null;
      function _prefix() { try { return _prefixProvider ? _prefixProvider() : ""; } catch { return ""; } }
      // HUD supplies last game's names (raw TMP, own name filtered)
      let _rosterProvider = null;
      function _roster() { try { return _rosterProvider ? _rosterProvider() : []; } catch { return []; } }
      return {
        setPrefixProvider(fn) { _prefixProvider = fn; },
        setRosterProvider(fn) { _rosterProvider = fn; },
        // v13.6: HUD calls this from /login response too, not just Forge open.
        // fixes the "steal, refresh, receipt expires before Forge opens" case
        // that v13.5's self-heal was supposed to catch.
        verifyStolenName(rawNickname) { verifyPendingSteal(rawNickname); },
        refresh() { if (_rgnfPanel) render(_rgnfPanel); },
        // called on Forge open and on account switch. per-account state wins;
        // otherwise seed from the current account's live nickname (never leak).
        syncToCurrentPlayer(userId, displayName, rawNickname) {
          if (!userId) return;
          if (rawNickname) _lastRawNickname = String(rawNickname);
          const prevId = _currentUserId;
          _currentUserId = userId;
          // must run before the same-account early return, verification fires
          // on every boot, not just account switches (latch inside makes it free)
          verifyPendingSteal(rawNickname);
          if (prevId === userId) return;
          const perUser = loadJSON(stateKey(), null);
          if (perUser) {
            state = Object.assign(defaultState(), perUser);
          } else {
            // fresh seed: the whole current in-game name as a raw snapshot.
            // first styling edit clears it and rebuilds from state.name.
            state = defaultState();
            const raw = String(rawNickname || "").trim();
            if (raw) {
              state.rawCode = raw;
              state.name = raw.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
            } else {
              state.name = String(displayName || "").trim();
            }
            saveJSON(stateKey(), state);
          }

          // must render unconditionally. panel DOM exists from page load,
          // and sync runs before mountIn on first open, gating on _mountedIn
          // meant the swapped state never reached the screen.
          if (_rgnfPanel) render(_rgnfPanel);
        },
        // re-parent the panel into the HUD tab; scroll lives on the container
        mountIn(container) {
          if (!_rgnfPanel || _mountedIn === container) return;
          _rgnfPanel.style.position = 'static';
          _rgnfPanel.style.transform = 'none';
          _rgnfPanel.style.left = _rgnfPanel.style.top = _rgnfPanel.style.right = _rgnfPanel.style.bottom = '';
          _rgnfPanel.style.width = '100%';
          _rgnfPanel.style.maxWidth = '100%';
          _rgnfPanel.style.maxHeight = 'none';
          _rgnfPanel.style.overflow = 'visible';
          _rgnfPanel.style.padding = '8px 10px';
          _rgnfPanel.style.border = 'none';
          _rgnfPanel.style.boxShadow = 'none';
          _rgnfPanel.style.background = 'transparent';
          _rgnfPanel.style.display = 'block';
          _rgnfPanel.classList.remove('rgnf-open');
          container.appendChild(_rgnfPanel);
          _mountedIn = container;
        },
      };
    })();

})();
