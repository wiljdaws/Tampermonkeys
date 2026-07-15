// ==UserScript==
// @name         Rocket Goal HUD
// @namespace    https://rocketgoal.io
// @version      6.0
// @description  Live stats HUD for Rocket Goal - ratings, win rates, equipped car, hidden automatically during matches
// @author       Dawson
// @match        https://rocketgoal.io/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.js
// @downloadURL  https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.js
// ==/UserScript==

(function () {
    'use strict';

    let hud;

    // skin id -> display name, confirmed against the in-game shop grid
    const SKIN_NAMES = {
        "body.0": "Vortex",
        "body.1": "Overdrive",
        "body.2": "Crimson",
        "body.3": "Specter",
        "body.4": "Frostbite",
        "body.5": "Pulsewave",
        "body.6": "Blaze",
        "body.7": "Nitron",
    };

    function skinName(id) {
        return SKIN_NAMES[id] || id;
    }

    // ---------- HUD ----------

    function createHUD() {
        if (hud) return;

        hud = document.createElement("div");
        hud.id = "rgHUD";

        hud.style.cssText = `
            position:fixed;
            top:20px;
            right:20px;
            width:280px;
            background:rgba(18,18,22,.88);
            color:white;
            border:2px solid #00bfff;
            border-radius:12px;
            font-family:Arial,sans-serif;
            padding:12px;
            z-index:999999999;
            box-shadow:0 0 15px #00bfff55;
            user-select:none;
        `;

        hud.innerHTML = `
            <div style="font-size:18px;font-weight:bold;color:#00bfff;cursor:move" id="rgDragHandle">
                🚀 Rocket Goal HUD
            </div>
            <hr>
            <div id="rgContent">Waiting for data...</div>
            <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
                <button id="rgToggle" style="flex:1;">Hide</button>
                <button id="rgRename" style="flex:1;">✏️ Rename</button>
                <button id="rgSub" style="flex:1;">📺 Sub</button>
                <button id="rgLeaderboard" style="flex:1;">🏆 Board</button>
            </div>
        `;

        document.body.appendChild(hud);
        dragElement(hud, document.getElementById("rgDragHandle"));

        document.getElementById("rgToggle").onclick = () => manualToggle();
        document.getElementById("rgSub").onclick = () => {
            window.open("https://www.youtube.com/@RootedEngineering", "_blank", "noopener");
        };
        document.getElementById("rgLeaderboard").onclick = () => {
            window.open("https://abuarqob.github.io/rgleaderboard/", "_blank", "noopener");
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
        const content = document.getElementById("rgContent");
        const visible = content.style.display !== "none";
        content.style.display = visible ? "none" : "block";
        document.getElementById("rgToggle").textContent = visible ? "Show" : "Hide";
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
            <b>XP</b> ${data.AccountXp ?? "—"}<br><br>

            <b>🏆 Ratings</b><br>
            3v3: <span style="color:#00ff66">${rating("Competitive3v3")}</span><br>
            2v2: <span style="color:#00ff66">${rating("Competitive2v2")}</span><br>
            1v1: <span style="color:#00ff66">${rating("Competitive1v1")}</span><br>
            Casual: ${rating("Casual")}<br><br>

            Wins: ${totalWins}<br>
            Matches Played: ${totalMatches}<br><br>

            <b>📊 Win Rates</b><br>
            3v3 ${wr("Competitive3v3")}%<br>
            2v2 ${wr("Competitive2v2")}%<br>
            1v1 ${wr("Competitive1v1")}%<br>
            Casual ${wr("Casual")}%<br><br>

            <b>🚗 Equipped</b><br>
            ${skinName(data.EquippedSkinId)}
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

    let forceRenamePrompt = false;

    async function submitToLeaderboard(data) {
        const fb = await initFirebase();
        if (!fb) return; // disabled or failed to load, silently skip

        const docRef = fb.doc(fb.db, LEADERBOARD_COLLECTION, data.Id);

        // Only ask for a display name once per player, ever -- unless the
        // Rename button forces it, in which case we always re-ask (but still
        // pre-fill their current name rather than starting from scratch).
        let existingDisplayName = null;
        try {
            const existing = await fb.getDoc(docRef);
            if (existing.exists() && existing.data().displayName) {
                existingDisplayName = existing.data().displayName;
            }
        } catch (e) {
            // couldn't read existing doc (e.g. rules deny read for some reason) -- fall through and ask anyway
        }

        let displayName = (!forceRenamePrompt && existingDisplayName) ? existingDisplayName : null;
        const isRename = forceRenamePrompt && !!existingDisplayName;
        forceRenamePrompt = false;

        if (!displayName) {
            const MAX_DISPLAY_NAME_LENGTH = 20;
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
                if (entered.length > 0 && entered.length <= MAX_DISPLAY_NAME_LENGTH) {
                    break; // valid, stop asking
                }
                // else: empty or too long, loop back and ask again
            }

            displayName = entered || suggestion;
        }

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

        try {
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
            const q = fb.query(
                fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                fb.where("sourceUserId", "==", sourceUserId),
                fb.where("playlist", "==", playlist)
            );

            try {
                const existing = await fb.getDocs(q);
                if (!existing.empty) {
                    const docId = existing.docs[0].id;
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, docId), fields, { merge: true });
                } else {
                    await fb.addDoc(fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION), {
                        ...fields,
                        sourceUserId,
                        playlist,
                    });
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
                try {
                    const skinId = JSON.parse(text);
                    if (lastKnownPlayerData) {
                        lastKnownPlayerData.EquippedSkinId = skinId;
                        updateHUD(lastKnownPlayerData);
                    } else {
                        const el = document.getElementById("rgContent");
                        if (el) {
                            el.innerHTML = el.innerHTML.replace(
                                /(<b>🚗 Equipped<\/b><br>\s*)[^<]*/,
                                `$1${skinName(skinId)}`
                            );
                        }
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
