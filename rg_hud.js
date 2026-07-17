// ==UserScript==
// @name         Rocket Goal HUD
// @namespace    https://rocketgoal.io
// @version      8.5
// @description  Live stats HUD for Rocket Goal - MMR ratings and win rates auto updates leaderboard
// @author       JesusDied4U
// @match        https://rocketgoal.io/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.js
// @downloadURL  https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.js
// @supportURL   https://github.com/wiljdaws/Tampermonkeys/issues
// ==/UserScript==

(function () {
    'use strict';

    let hud;

    // ---------- HUD ----------

    function createHUD() {
        if (hud) return;

        hud = document.createElement("div");
        hud.id = "rgHUD";

        hud.style.cssText = `
            position:fixed;
            top:110px;
            right:20px;
            width:250px;
            background:rgba(18,18,22,.88);
            color:white;
            border:2px solid #00bfff;
            border-radius:12px;
            font-family:Arial,sans-serif;
            padding:10px;
            z-index:999999999;
            animation: rgGlowSpin 3s linear infinite;
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
                    transition: background 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
                }
                #rgHUD .rgBtn:hover {
                    background: linear-gradient(180deg, #26405a, #16222c);
                    border-color: #00bfff;
                }
                #rgHUD .rgBtn:active {
                    transform: scale(0.96);
                }
                @keyframes rgGlowSpin {
                    0%    { box-shadow: 12px 0px 22px 6px #ff7a00, -12px 0px 22px 6px #00d4ff; }
                    12.5% { box-shadow: 8.5px 8.5px 22px 6px #ff7a00, -8.5px -8.5px 22px 6px #00d4ff; }
                    25%   { box-shadow: 0px 12px 22px 6px #ff7a00, 0px -12px 22px 6px #00d4ff; }
                    37.5% { box-shadow: -8.5px 8.5px 22px 6px #ff7a00, 8.5px -8.5px 22px 6px #00d4ff; }
                    50%   { box-shadow: -12px 0px 22px 6px #ff7a00, 12px 0px 22px 6px #00d4ff; }
                    62.5% { box-shadow: -8.5px -8.5px 22px 6px #ff7a00, 8.5px 8.5px 22px 6px #00d4ff; }
                    75%   { box-shadow: 0px -12px 22px 6px #ff7a00, 0px 12px 22px 6px #00d4ff; }
                    87.5% { box-shadow: 8.5px -8.5px 22px 6px #ff7a00, -8.5px 8.5px 22px 6px #00d4ff; }
                    100%  { box-shadow: 12px 0px 22px 6px #ff7a00, -12px 0px 22px 6px #00d4ff; }
                }
            </style>
            <div style="display:flex;align-items:center;justify-content:space-between;cursor:move" id="rgDragHandle">
                <span style="font-size:18px;font-weight:bold;color:#00bfff;">🚀 Rocket Goal HUD</span>
                <button id="rgMinimize" title="Minimize" style="
                    background:none;
                    border:1px solid #00bfff88;
                    color:#00bfff;
                    border-radius:4px;
                    width:22px;
                    height:22px;
                    font-size:14px;
                    line-height:1;
                    cursor:pointer;
                    flex-shrink:0;
                ">–</button>
            </div>
            <hr>
            <div id="rgBody">
                <div id="rgContent">Waiting for data...</div>
                <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">
                    <button id="rgRename" class="rgBtn">✏️ Rename</button>
                    <button id="rgSub" class="rgBtn">📺 Sub</button>
                    <button id="rgLeaderboard" class="rgBtn">🏆 Board</button>
                    <button id="rgReportBug" class="rgBtn">🐛 Bug</button>
                </div>
            </div>
        `;

        document.body.appendChild(hud);
        dragElement(hud, document.getElementById("rgDragHandle"));

        document.getElementById("rgMinimize").onclick = () => manualToggle();
        document.getElementById("rgSub").onclick = () => {
            window.open("https://www.youtube.com/@RootedEngineering", "_blank", "noopener");
        };
        document.getElementById("rgLeaderboard").onclick = () => {
            window.open("https://abuarqob.github.io/rgleaderboard/", "_blank", "noopener");
        };
        document.getElementById("rgReportBug").onclick = () => {
            window.open("https://github.com/wiljdaws/Tampermonkeys/issues/new", "_blank", "noopener");
        };
        document.getElementById("rgRename").onclick = () => {
            if (!lastKnownPlayerData) {
                alert("Play a match or log in first, then you can set your leaderboard name.");
                return;
            }
            forceRenamePrompt = true;
            submitToLeaderboard(lastKnownPlayerData);
        };
    }

    function dragElement(el, handle) {
        let dx = 0, dy = 0;

        handle.onmousedown = e => {
            if (e.target.closest("#rgMinimize")) return; // let the button handle its own click
            e.preventDefault();
            dx = e.clientX;
            dy = e.clientY;
            document.onmousemove = drag;
            document.onmouseup = () => {
                document.onmousemove = null;
                document.onmouseup = null;
            };
        };

        function drag(e) {
            e.preventDefault();
            const moveX = dx - e.clientX;
            const moveY = dy - e.clientY;
            dx = e.clientX;
            dy = e.clientY;
            el.style.top = (el.offsetTop - moveY) + "px";
            el.style.left = (el.offsetLeft - moveX) + "px";
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
    }

    function updateHUD(data) {
        createHUD();
        lastKnownPlayerData = data;

        const rating = mode => data.ModesGlicko?.[mode]?.displayRating ?? "—";

        const wr = mode => {
            const d = data.ModesData?.[mode];
            if (!d || !d.matchesPlayed) return "0.0";
            return (100 * d.wins / d.matchesPlayed).toFixed(1);
        };

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        document.getElementById("rgContent").innerHTML = `
            <div style="display:flex;">
                <div style="flex:1;">
                    <b>🏆 Ratings</b><br>
                    3v3: <span style="color:#00ff66">${rating("Competitive3v3")}</span><br>
                    2v2: <span style="color:#00ff66">${rating("Competitive2v2")}</span><br>
                    1v1: <span style="color:#00ff66">${rating("Competitive1v1")}</span><br>
                    Casual: <span style="color:#00ff66">${rating("Casual")}</span>
                </div>
                <div style="width:1px;background:#00bfff88;margin:0 8px;"></div>
                <div style="flex:1;">
                    <b>📊 Win Rates</b><br>
                    3v3 <span style="color:#00ff66">${wr("Competitive3v3")}%</span><br>
                    2v2 <span style="color:#00ff66">${wr("Competitive2v2")}%</span><br>
                    1v1 <span style="color:#00ff66">${wr("Competitive1v1")}%</span><br>
                    Casual <span style="color:#00ff66">${wr("Casual")}%</span>
                </div>
            </div>

            <hr style="border:none;border-top:1px solid #00bfff88;margin:10px 0;">

            Wins: <span style="color:#00ff66">${totalWins}</span><br>
            Matches Played: <span style="color:#00ff66">${totalMatches}</span>
        `;
    }

    let lastProcessedText = null;

    function tryParseAndUpdate(text) {
        // The game's own code logs the exact same response text to console.log
        // that our fetch hook also sees separately, so the identical event can
        // reach here twice in a row. Skip the repeat instead of double-processing.
        if (text === lastProcessedText) return;

        try {
            const data = JSON.parse(text);
            if (data && data.ModesGlicko) {
                lastProcessedText = text;
                updateHUD(data);
                submitToLeaderboard(data);
            }
        } catch (e) {}
    }

    // ---------- Leaderboard submission (optional) ----------

    // TODO: fill these in from Pal's Firebase project settings
    // (Firebase Console -> Project Settings -> General -> "Your apps" -> Web app config)
    // Leave FIREBASE_CONFIG as null to disable leaderboard submission entirely.
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
        authDomain: "rgleaderboard.firebaseapp.com",
        projectId: "rgleaderboard",
        storageBucket: "rgleaderboard.firebasestorage.app",
        messagingSenderId: "247848634543",
        appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
        measurementId: "G-JW3Q972P9T",
    };

    // IMPORTANT: this is intentionally NOT "leaderboard" -- that collection is
    // manually curated by Pal through his site's admin panel (one document per
    // player per game mode, with hand-picked cosmetic fields like flag/glowColor
    // that we have no way to generate). Writing into that collection with our
    // own schema is what broke the site earlier. This writes to a separate
    // collection instead; Pal can decide if/how to pull from it manually.
    const LEADERBOARD_COLLECTION = "script_submissions";

    let firestoreReady = null; // will hold { db, doc, setDoc } once loaded

    async function initFirebase() {
        if (!FIREBASE_CONFIG) return null;
        if (firestoreReady) return firestoreReady;

        try {
            const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
            const { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc } =
                await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

            const app = initializeApp(FIREBASE_CONFIG);
            const db = getFirestore(app);

            firestoreReady = { db, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc };
            return firestoreReady;
        } catch (e) {
            console.error("[RG HUD] Firebase init failed:", e);
            return null;
        }
    }

    // Strips TextMeshPro rich-text tags (<#rrggbb>, <br>, <sub>, etc.) so a
    // decorated in-game nickname has a sane plain-text fallback to suggest.
    function cleanName(name) {
        return (name ?? "")
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    // Not exhaustive, but catches a lot more than before. Word-boundary matching
    // so it doesn't falsely flag innocent words that merely contain a bad word
    // as a substring (e.g. "classic", "assassin", "Scunthorpe").
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

    function containsProfanity(text) {
        return PROFANITY_REGEX.test(text);
    }

    // Skip brand-new accounts that haven't played anything yet -- otherwise a
    // fresh login before a single match creates a clutter entry with 0 wins,
    // 0 matches, and whatever name they happened to type at the prompt.
    function hasPlayedAnything(data) {
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        return modes.some(m => (data.ModesData?.[m]?.matchesPlayed ?? 0) > 0);
    }

    let forceRenamePrompt = false;

    // Serializes submitToLeaderboard per player, so if the game fires two
    // login-ish events close together (happens on a fresh install/first run),
    // the second call waits for the first to finish deciding on a display name
    // (and saving it) instead of racing it and also concluding "no name yet" --
    // which is what caused the rename prompt to pop up twice.
    const submitLocks = new Map();

    async function submitToLeaderboard(data) {
        const lockKey = data.Id;
        const previous = submitLocks.get(lockKey) || Promise.resolve();
        const current = previous.then(() => submitToLeaderboardInner(data));
        submitLocks.set(lockKey, current);
        await current;
    }

    // Simple running counter so you can actually see how many real Firestore
    // writes are happening, instead of guessing. Check the console.
    let firestoreWriteCount = 0;
    function logWrite(label) {
        firestoreWriteCount++;
        console.log(`[RG HUD] Firestore write #${firestoreWriteCount} (${label})`);
    }

    // Caches the resolved display name per player so repeat calls in the same
    // session skip the getDoc read entirely instead of re-fetching the same answer.
    const cachedDisplayNames = new Map();

    // Skip the whole Firebase round-trip if this player's data hasn't actually
    // changed since the last time we synced -- login often reports the same
    // stats as the matchEnd that just happened moments before.
    const lastSyncSnapshot = new Map();

    // Caches which real document belongs to a given player+mode after the first
    // lookup, so repeat syncs in the same session skip the read entirely and
    // go straight to a known document ID instead of re-querying every time.
    const knownDocIds = new Map();

    // Simple safety-net cooldown regardless of the above -- no player can
    // trigger more than one real sync within this window.
    const SYNC_COOLDOWN_MS = 20000;
    const lastSyncTime = new Map();

    async function submitToLeaderboardInner(data) {
        if (!hasPlayedAnything(data)) return; // brand new account, nothing to show yet

        const fb = await initFirebase();
        if (!fb) return; // disabled or failed to load, silently skip

        const docRef = fb.doc(fb.db, LEADERBOARD_COLLECTION, data.Id);

        // Only ask for a display name once per player, ever -- unless the
        // Rename button forces it, in which case we always re-ask (but still
        // pre-fill their current name rather than starting from scratch).
        // Cached in memory after the first lookup so repeat calls this session
        // don't need a fresh Firestore read just to find the same answer again.
        let existingDisplayName = cachedDisplayNames.get(data.Id) ?? null;

        if (!existingDisplayName || forceRenamePrompt) {
            try {
                const existing = await fb.getDoc(docRef);
                if (existing.exists() && existing.data().displayName) {
                    existingDisplayName = existing.data().displayName;
                }
            } catch (e) {
                // couldn't read existing doc (e.g. rules deny read for some reason) -- fall through and ask anyway
            }
        }

        let displayName = (!forceRenamePrompt && existingDisplayName) ? existingDisplayName : null;
        const isRename = forceRenamePrompt && !!existingDisplayName;
        forceRenamePrompt = false;

        if (!displayName) {
            const MAX_DISPLAY_NAME_LENGTH = 15;
            const suggestion = (existingDisplayName || cleanName(data.Nickname)).slice(0, MAX_DISPLAY_NAME_LENGTH) || "Player";
            const promptLabel = isRename
                ? `Enter your new leaderboard name (max ${MAX_DISPLAY_NAME_LENGTH} characters):`
                : `First time submitting your stats! What name should show up on the leaderboard? (max ${MAX_DISPLAY_NAME_LENGTH} characters)`;

            let entered = null;
            while (true) {
                entered = window.prompt(promptLabel, suggestion);

                if (entered === null) {
                    // they cancelled -- just use the suggestion, don't nag them
                    entered = suggestion;
                    break;
                }

                entered = entered.trim();

                if (entered.length === 0 || entered.length > MAX_DISPLAY_NAME_LENGTH) {
                    continue; // empty or too long, loop back and ask again
                }

                if (containsProfanity(entered)) {
                    alert("That name isn't allowed on the leaderboard. Please pick something else.");
                    continue;
                }

                break; // valid, stop asking
            }

            displayName = entered || suggestion;
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
        };

        // Skip the actual network writes if nothing worth syncing has changed,
        // or if we synced very recently -- but never skip a deliberate Rename.
        const snapshotKey = JSON.stringify({
            displayName, ratings: payload.ratings, stats: payload.stats,
            xp: payload.xp, equippedSkinId: payload.equippedSkinId,
        });
        const now = Date.now();
        const unchanged = lastSyncSnapshot.get(data.Id) === snapshotKey;
        const withinCooldown = (now - (lastSyncTime.get(data.Id) ?? 0)) < SYNC_COOLDOWN_MS;

        if (!isRename && (unchanged || withinCooldown)) {
            return;
        }

        lastSyncSnapshot.set(data.Id, snapshotKey);
        lastSyncTime.set(data.Id, now);

        try {
            logWrite("script_submissions");
            await fb.setDoc(docRef, payload, { merge: true });
        } catch (e) {
            console.error("[RG HUD] Leaderboard submission failed:", e);
        }

        await syncToRealLeaderboard(fb, data, displayName);
    }

    const REAL_LEADERBOARD_COLLECTION = "leaderboard";

    // Serializes calls per player+mode so two near-simultaneous writes for the
    // same key can never race each other into creating two documents -- the
    // second call always waits for the first to fully finish before it even
    // starts its own "does this already exist" check.
    const upsertLocks = new Map();

    // Finds this player's entry for one playlist by sourceUserId and updates it,
    // whether that entry was created by the script OR is a pre-existing
    // manually-curated one that Pal tagged with a matching sourceUserId field.
    // Either way, merge:true means flag/icons/glowColor/glowStrength Pal set
    // by hand are never touched. If nothing matches, creates a fresh entry.
    async function upsertPlaylistEntry(fb, sourceUserId, playlist, fields) {
        const lockKey = `${sourceUserId}_${playlist}`;
        const previous = upsertLocks.get(lockKey) || Promise.resolve();

        const current = previous.then(async () => {
            const cacheKey = `${sourceUserId}_${playlist}`;
            const cachedId = knownDocIds.get(cacheKey);

            try {
                if (cachedId) {
                    // Already know which doc this is from earlier this session --
                    // skip the query/read entirely and write straight to it.
                    // If Pal happened to delete it since, setDoc just recreates
                    // it fresh at that same ID, so this is safe either way.
                    logWrite(`leaderboard/${playlist} (cached id)`);
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, cachedId), fields, { merge: true });
                    return;
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
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, docId), fields, { merge: true });
                } else {
                    logWrite(`leaderboard/${playlist} (new doc)`);
                    const newDoc = await fb.addDoc(fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION), {
                        ...fields,
                        sourceUserId,
                        playlist,
                    });
                    knownDocIds.set(cacheKey, newDoc.id);
                }
            } catch (e) {
                console.error(`[RG HUD] Real leaderboard sync failed for ${playlist}:`, e);
            }
        });

        upsertLocks.set(lockKey, current);
        await current;
    }

    async function syncToRealLeaderboard(fb, data, displayName) {
        const sourceUserId = data.Id;
        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
            const mmr = data.ModesGlicko?.[mode]?.displayRating;
            if (typeof mmr !== "number") continue; // player hasn't played this mode -- skip it
            await upsertPlaylistEntry(fb, sourceUserId, playlist, { name: displayName, mmr });
        }

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        await upsertPlaylistEntry(fb, sourceUserId, "wins", {
            name: displayName,
            wins: totalWins,
            matches: totalMatches,
        });
    }

    // ---------- Network capture ----------

    // Track the currently equipped skin so partial-response endpoints (equipSkin) can update the HUD
    let lastKnownPlayerData = null;

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
                tryParseAndUpdate(text);
                setAutoVisible(true); // match ended -> bring the whole HUD back
            } else if (url.includes("/v0304_login/login")) {
                tryParseAndUpdate(text);
            } else if (url.includes("/v0304_player/equipSkin")) {
                // response is just a bare quoted skin id, e.g. "body.2"
                // No longer displayed in the HUD, but still tracked in case it's needed later.
                try {
                    const skinId = JSON.parse(text);
                    if (lastKnownPlayerData) {
                        lastKnownPlayerData.EquippedSkinId = skinId;
                    }
                } catch (e) {}
            }
        } catch (e) {}
        return response;
    };

    const oldLog = console.log;
    console.log = function (...args) {
        oldLog.apply(console, args);
        for (const arg of args) {
            if (typeof arg !== "string") continue;

            if (arg.includes('"ModesGlicko"')) {
                const json = arg.substring(arg.indexOf("{"));
                tryParseAndUpdate(json);
            }

            // This only fires when a real match with real teams is forming --
            // it never fires for an empty party or just sitting in a lobby.
            if (arg.includes("[PlayerDataManager] Initialized stats for player")) {
                setAutoVisible(false);
            }

            // Being back in a party/lobby room means you're not mid-match anymore.
            // This catches early-quit cases where matchEnd never fires.
            if (arg.includes("OnJoinedRoom Party")) {
                setAutoVisible(true);
            }
        }
    };

    // Note: we no longer hook WebSocket at all. Photon opens the same kind of
    // "/game/" room connection for both party lobbies and real matches, so it
    // can't reliably distinguish the two -- the PlayerDataManager console line
    // above and the matchEnd fetch below are both real, unambiguous signals instead.

    // ---------- Boot ----------

    const wait = setInterval(() => {
        if (document.body) {
            clearInterval(wait);
            createHUD();
            console.log("[RG HUD] loaded and running, waiting for login/matchEnd data...");
        }
    }, 100);

})();
