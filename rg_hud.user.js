// ==UserScript==
// @name         Rocket Goal HUD
// @namespace    https://rocketgoal.io
// @version      10.9
// @description  Live stats HUD for Rocket Goal - ratings, ranks, session deltas, win rates, auto leaderboard sync, customizable glow
// @author       JesusDied4U
// @match        https://rocketgoal.io/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js
// @downloadURL  https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js
// @supportURL   https://github.com/wiljdaws/Tampermonkeys/issues
// ==/UserScript==

(function () {
    'use strict';

    let hud;

    // ---------- Settings (persisted in localStorage) ----------

    const DEFAULT_SETTINGS = {
        glowEnabled: true,
        glowSpeed: 5,        // speed level 1-10, higher = faster
        glowOpacity: 0.6,    // vibrancy
        glowColor1: "#ff7a00",
        glowColor2: "#00d4ff",
    };

    let settings = { ...DEFAULT_SETTINGS };
    try {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("rgHudSettings") ?? "{}") };
    } catch (e) {}

    function saveSettings() {
        try { localStorage.setItem("rgHudSettings", JSON.stringify(settings)); } catch (e) {}
    }

    function hexToRgba(hex, alpha) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!m) return hex;
        return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
    }

    // Regenerates the glow keyframes from current settings and applies them.
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
        // Speed level 1-10 maps to rotation duration 20s (crawl) down to ~1.5s (fast).
        // Momentum applies a speed multiplier on top (on fire = faster, cold = slower).
        const baseDuration = 22 - (settings.glowSpeed * 2.05);
        const duration = baseDuration / momentumGlow.speedMult;
        hud.style.boxShadow = "";
        hud.style.animation = `rgGlowSpin ${duration.toFixed(2)}s linear infinite`;
    }

    // ---------- HUD ----------

    function createHUD() {
        if (hud) return;

        hud = document.createElement("div");
        hud.id = "rgHUD";

        // Restore last dragged position if saved
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
                <span id="rgTitle" style="font-size:16px;font-weight:bold;color:#00bfff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🚀 Rocket Goal HUD</span>
                <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
                    <span id="rgErrDot" title="" style="display:none;color:#ff5555;font-weight:bold;font-size:14px;">⚠</span>
                    <button id="rgClanBtn" class="rgIconBtn" title="Clans">🛡️</button>
                    <button id="rgSettingsBtn" class="rgIconBtn" title="Settings">⚙</button>
                    <button id="rgMinimize" class="rgIconBtn" title="Minimize">–</button>
                </div>
            </div>
            <hr>
            <div id="rgBody">
                <div id="rgStatsView">
                    <div id="rgContent">Waiting for data...</div>
                    <div id="rgSettingsPanel" style="display:none;border-top:1px solid #00bfff44;margin-top:8px;padding-top:6px;">
                        <div class="rgSettingRow"><span>Glow</span><input type="checkbox" id="rgSetGlow"></div>
                        <div class="rgSettingRow"><span>Speed</span><input type="range" id="rgSetSpeed" min="1" max="10" step="0.5"></div>
                        <div class="rgSettingRow"><span>Vibrancy</span><input type="range" id="rgSetOpacity" min="0.1" max="1" step="0.05"></div>
                        <div class="rgSettingRow"><span>Color 1</span><input type="color" id="rgSetColor1"></div>
                        <div class="rgSettingRow"><span>Color 2</span><input type="color" id="rgSetColor2"></div>
                        <button id="rgSetReset" class="rgBtn" style="width:100%;margin-top:4px;">Reset to defaults</button>
                    </div>
                </div>
                <div id="rgClanView" style="display:none;">Loading clans...</div>
                <div style="margin-top:6px;display:flex;gap:4px;">
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
            <div id="rgDialog">
                <div id="rgDialogMsg" class="rgDlgMsg"></div>
                <input type="text" id="rgDialogInput" style="display:none;" maxlength="200">
                <div style="display:flex;gap:6px;">
                    <button id="rgDialogOk" class="rgBtn">OK</button>
                    <button id="rgDialogCancel" class="rgBtn">Cancel</button>
                </div>
            </div>
            <div id="rgToast"></div>
        `;

        document.body.appendChild(hud);
        clampHudOnScreen();
        window.addEventListener("resize", clampHudOnScreen);
        dragElement(hud, document.getElementById("rgDragHandle"));
        applyGlowSettings();

        // Custom themed tooltip (replaces native title= tooltips, which can't be
        // styled and have a slow show delay). One shared element, positioned near
        // the cursor whenever hovering anything with a data-tip.
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
            // Position above-right of cursor, nudged to stay on screen.
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

        document.getElementById("rgMinimize").onclick = () => manualToggle();
        document.getElementById("rgSub").onclick = () => {
            window.open("https://www.youtube.com/@RootedEngineering", "_blank", "noopener");
        };
        document.getElementById("rgLeaderboard").onclick = () => {
            window.open("https://abuarqob.github.io/rgleaderboard/", "_blank", "noopener");
        };
        document.getElementById("rgRename").onclick = () => {
            if (!lastKnownPlayerData) {
                showNameModal("Play a match or log in first!", "", false, () => {});
                hideNameModalSoon();
                return;
            }
            forceRenamePrompt = true;
            submitToLeaderboard(lastKnownPlayerData);
        };

        // Clan view toggle (shield icon) -- swaps stats view for clan view
        const statsView = document.getElementById("rgStatsView");
        const clanView = document.getElementById("rgClanView");
        const panel = document.getElementById("rgSettingsPanel");
        document.getElementById("rgClanBtn").onclick = () => {
            const showingClan = clanView.style.display !== "none";
            if (showingClan) {
                clanView.style.display = "none";
                statsView.style.display = "block";
            } else {
                panel.style.display = "none"; // close settings if it was open
                statsView.style.display = "none";
                clanView.style.display = "block";
                renderClanView();
            }
        };

        // Settings panel wiring -- opening settings always returns to the stats
        // view first, so the panel (which lives inside stats) is actually visible.
        document.getElementById("rgSettingsBtn").onclick = () => {
            const opening = panel.style.display === "none";
            if (opening) {
                clanView.style.display = "none";   // leave clan view if it was open
                statsView.style.display = "block";
                panel.style.display = "block";
            } else {
                panel.style.display = "none";
            }
        };

        const setGlow = document.getElementById("rgSetGlow");
        const setSpeed = document.getElementById("rgSetSpeed");
        const setOpacity = document.getElementById("rgSetOpacity");
        const setColor1 = document.getElementById("rgSetColor1");
        const setColor2 = document.getElementById("rgSetColor2");

        function syncSettingInputs() {
            setGlow.checked = settings.glowEnabled;
            setSpeed.value = settings.glowSpeed;
            setOpacity.value = settings.glowOpacity;
            setColor1.value = settings.glowColor1;
            setColor2.value = settings.glowColor2;
        }
        syncSettingInputs();

        setGlow.onchange = () => { settings.glowEnabled = setGlow.checked; saveSettings(); applyGlowSettings(); };
        setSpeed.oninput = () => { settings.glowSpeed = parseFloat(setSpeed.value); saveSettings(); applyGlowSettings(); };
        setOpacity.oninput = () => { settings.glowOpacity = parseFloat(setOpacity.value); saveSettings(); applyGlowSettings(); };
        setColor1.oninput = () => { settings.glowColor1 = setColor1.value; saveSettings(); applyGlowSettings(); };
        setColor2.oninput = () => { settings.glowColor2 = setColor2.value; saveSettings(); applyGlowSettings(); };
        document.getElementById("rgSetReset").onclick = () => {
            settings = { ...DEFAULT_SETTINGS };
            saveSettings();
            syncSettingInputs();
            applyGlowSettings();
        };
    }

    // Keeps the HUD reachable: if a saved/dragged position has pushed it (mostly)
    // off-screen, pull it back so at least a good chunk of the title bar stays
    // visible and grabbable. Prevents the "dragged off-screen and can't get it
    // back because it reloads off-screen" trap.
    function clampHudOnScreen() {
        if (!hud) return;
        const rect = hud.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const MARGIN = 40; // keep at least this many px of the HUD on each edge

        let left = rect.left;
        let top = rect.top;

        // Horizontal: never fully off left/right.
        if (left + rect.width < MARGIN) left = MARGIN - rect.width;   // too far left
        if (left > vw - MARGIN) left = vw - MARGIN;                    // too far right
        // Vertical: keep the title bar row on-screen (top can't go above 0 or
        // below the viewport bottom minus a margin).
        if (top < 0) top = 0;
        if (top > vh - MARGIN) top = vh - MARGIN;

        if (left !== rect.left || top !== rect.top) {
            hud.style.left = left + "px";
            hud.style.top = top + "px";
            hud.style.right = "auto";
            // Persist the corrected position so it stays fixed next load too.
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
            if (e.target.closest(".rgIconBtn")) return; // buttons handle their own clicks
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
    // The game only gives cumulative totals, not per-match results. But by
    // comparing this update's totals to the last, we can infer each match's
    // outcome as it happens and chain them into a streak. Overall (any mode).
    // A positive count = win streak (🔥), negative = loss streak (❄️). Persisted
    // in localStorage keyed to the session so it survives refreshes but resets
    // with the session / on account change.

    let streakData = null;
    try { streakData = JSON.parse(localStorage.getItem("rgHudStreak") ?? "null"); } catch (e) {}

    function saveStreak() {
        try { localStorage.setItem("rgHudStreak", JSON.stringify(streakData)); } catch (e) {}
    }

    function resetStreak(accountId, totalWins, totalMatches) {
        streakData = { accountId, streak: 0, lastWins: totalWins, lastMatches: totalMatches };
        saveStreak();
    }

    function updateStreak(data) {
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        // First observation this session (or account change) -- establish a
        // baseline without counting anything, since we don't know prior outcomes.
        if (!streakData || streakData.accountId !== data.Id) {
            resetStreak(data.Id, totalWins, totalMatches);
            return;
        }

        const matchDiff = totalMatches - streakData.lastMatches;
        const winDiff = totalWins - streakData.lastWins;

        if (matchDiff <= 0) return; // no new matches since last check

        // Resolve each newly-played match in order. Usually just one, but if two
        // came in between updates we still tally them (all wins or all losses in
        // that gap -- we can't know the interleaving, so treat the block by net).
        const losses = matchDiff - winDiff;
        if (winDiff > 0 && losses === 0) {
            // pure win block
            streakData.streak = streakData.streak > 0 ? streakData.streak + winDiff : winDiff;
        } else if (losses > 0 && winDiff === 0) {
            // pure loss block
            streakData.streak = streakData.streak < 0 ? streakData.streak - losses : -losses;
        } else {
            // mixed block in one gap -- end on whichever was more recent is unknown,
            // so settle on the net sign, magnitude 1 (conservative).
            streakData.streak = winDiff >= losses ? 1 : -1;
        }

        streakData.lastWins = totalWins;
        streakData.lastMatches = totalMatches;
        saveStreak();
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

    // A "session" is a continuous play run. It resets when: the account changes,
    // OR there's been a gap of no activity longer than SESSION_IDLE_MS (e.g. you
    // played last night, slept, and came back today). Stored in localStorage with
    // a timestamp so a plain page refresh keeps the session, but a long break
    // starts a fresh one -- which sessionStorage alone couldn't distinguish.
    const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours

    let sessionStart = null;
    try { sessionStart = JSON.parse(localStorage.getItem("rgHudSessionStart") ?? "null"); } catch (e) {}

    function captureSessionStart(data) {
        const now = Date.now();
        const sameAccount = sessionStart && sessionStart.accountId === data.Id;
        const idledOut = sessionStart && (now - (sessionStart.lastSeen ?? 0)) > SESSION_IDLE_MS;

        if (sameAccount && !idledOut) {
            // Continuing the same session -- just refresh the activity timestamp.
            sessionStart.lastSeen = now;
            try { localStorage.setItem("rgHudSessionStart", JSON.stringify(sessionStart)); } catch (e) {}
            return;
        }

        // New session: fresh baseline. Also clear the per-entry write cache and
        // momentum so a new run doesn't inherit yesterday's state.
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

        // New session -> fresh streak baseline (don't count pre-session matches).
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const tw = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
        const tm = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);
        resetStreak(data.Id, tw, tm);

        // Account/session changed -> invalidate clan cache so it reloads for the
        // new account, and refresh the clan view if it's currently open.
        clanLoaded = false;
        clanLoadedForAccount = null;
        myClan = null;
        checkClanNotices(); // show any pending notice (e.g. kicked) for this account
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

    // ---------- Ranks ----------

    // playlist -> rank number; refreshed after our own data changes.
    const cachedRanks = new Map();
    // playlist -> mmr needed to pass the person one rank above you (null if #1).
    const cachedMmrToNext = new Map();

    function rankBadge(playlist) {
        const r = cachedRanks.get(playlist);
        if (!r) return "";

        // Tiered colors: gold for top 3, purple for top 10, cyan for top 25, gray beyond
        let color;
        if (r <= 3) color = "#ffd700";
        else if (r <= 10) color = "#c77dff";
        else if (r <= 25) color = "#00d4ff";
        else color = "#9aa5ad";

        // Hover tooltip (custom-styled): how much MMR to pass the next rank up.
        const gap = cachedMmrToNext.get(playlist);
        let tip;
        if (r === 1) tip = "You're #1! 👑";
        else if (typeof gap === "number") tip = `+${gap} MMR to reach #${r - 1}`;
        else tip = `Rank #${r}`;

        return ` <span class="rgHasTip" data-tip="${tip}" style="color:${color};font-size:10px;font-weight:bold;">#${r}</span>`;
    }

    // ---------- Crown system ----------
    // Title becomes KING while holding any #1; a coronation banner fires the
    // moment a #1 is newly taken, and a dethroned alert fires when it's lost.

    const prevRanks = new Map(); // playlist -> last known rank

    // ---------- Momentum system ----------
    // Based on net MMR gained/lost across all modes this session. Changes the
    // title and the glow speed/intensity (NOT the user's chosen colors).

    const MOMENTUM_TIERS = {
        flowState: 250,   // >= : "Flow State", the top tier -- fastest + most intense
        onFire:    150,   // >= : "ON FIRE", fast + bright glow
        heatingUp: 75,    // >= : "Heating Up", warmer/faster glow
        cold:      -20,   // <= : "Ice Cold", slow + dim glow
        shutEye:   -75,   // <= : easter egg
    };

    // Rotating easter-egg messages so a rough session doesn't repeat. Ribbing, not mean.
    const SHUT_EYE_MESSAGES = [
        "😴 Maybe it's time for some shut-eye?",
        "😴 The ball will still be here tomorrow...",
        "🛌 Consider: a strategic nap.",
        "☕ Touch grass? Or at least grab a coffee.",
        "😅 Rough one. Shake it off, champ.",
    ];
    let shutEyeMessage = SHUT_EYE_MESSAGES[Math.floor(Math.random() * SHUT_EYE_MESSAGES.length)];

    // Read by applyGlowSettings; momentum only changes speed & intensity, not colors.
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

    // Title priority: individual #1 crown beats clan-clash lead beats momentum beats default.
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
            default:          return { text: "🚀 Rocket Goal HUD", color: "#00bfff" };
        }
    }

    function applyTitle() {
        const titleEl = document.getElementById("rgTitle");
        if (!titleEl) return;
        const { text, color } = resolveTitle();
        titleEl.textContent = text;
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

            // Coronation: newly took #1 (only if we knew a previous, non-#1 rank --
            // avoids firing just because a session started while already on top)
            if (rank === 1 && typeof prev === "number" && prev !== 1) {
                showBanner(`👑 NEW #1 IN ${playlist.toUpperCase()}!`, "#ffd700");
            }

            // Dethroned: was #1, now isn't
            if (prev === 1 && rank !== 1) {
                showBanner(`⚔️ Dethroned in ${playlist.toUpperCase()}!`, "#ff6b6b");
            }

            prevRanks.set(playlist, rank);
        }

        applyTitle(); // crown state may have changed
    }

    // ---------- HUD content ----------

    function updateHUD(data) {
        createHUD();
        lastKnownPlayerData = data;
        captureSessionStart(data);
        updateStreak(data);
        updateMomentum();

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
                <div style="font-size:15px;">${streakBadge()}</div>
            </div>
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

    // ---------- Leaderboard submission ----------

    // Pal's Firebase web config -- this is the public client config, not a secret.
    // Set to null to disable all leaderboard submission.
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
        authDomain: "rgleaderboard.firebaseapp.com",
        projectId: "rgleaderboard",
        storageBucket: "rgleaderboard.firebasestorage.app",
        messagingSenderId: "247848634543",
        appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
        measurementId: "G-JW3Q972P9T",
    };

    // Raw per-player data dump, separate from the "leaderboard" collection the
    // site renders. Keeps the full stats snapshot (all modes, xp, raw nickname,
    // chosen displayName) as a record, while syncToRealLeaderboard below pushes
    // just the site-shaped entries into the real "leaderboard" collection.
    const LEADERBOARD_COLLECTION = "script_submissions";

    let firestoreReady = null; // holds the loaded Firestore SDK handles once initialized

    async function initFirebase() {
        if (!FIREBASE_CONFIG) return null;
        if (firestoreReady) return firestoreReady;

        try {
            const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
            const { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc, getCountFromServer, orderBy, limit, deleteDoc, serverTimestamp } =
                await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

            const app = initializeApp(FIREBASE_CONFIG);
            const db = getFirestore(app);

            firestoreReady = { db, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc, getCountFromServer, orderBy, limit, deleteDoc, serverTimestamp };
            return firestoreReady;
        } catch (e) {
            console.error("[RG HUD] Firebase init failed:", e);
            showError("Firebase failed to load");
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

    // Not exhaustive, but catches common attempts. Word-boundary matching so it
    // doesn't falsely flag innocent words (e.g. "classic", "assassin").
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

    // Rejects any name containing emoji / pictographic symbols, including all
    // flag forms (regional-indicator pairs and tag-sequence subdivision flags).
    const EMOJI_REGEX = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[\u{1F1E6}-\u{1F1FF}\u{1F3F3}\u{1F3F4}\u{E0020}-\u{E007F}\u{200D}]/u;
    function containsEmoji(text) {
        return EMOJI_REGEX.test(text);
    }

    // Skip brand-new accounts that haven't played anything yet.
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

    // Unity captures keyboard events at the window level (capture phase) and
    // preventDefaults printable characters, which kills typing in our input
    // before the event ever reaches it. Intercept one step earlier: while our
    // input is focused, stop the game from seeing keys at all.
    // input is focused, stop the game from seeing keys at all. Applies to ANY
    // text input inside the HUD (name modal, clan create form, etc.).
    ["keydown", "keyup", "keypress"].forEach(type => {
        window.addEventListener(type, e => {
            const active = document.activeElement;
            const inHud = active && hud && hud.contains(active)
                && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
                && active.type !== "checkbox" && active.type !== "range" && active.type !== "color";
            if (inHud) {
                e.stopImmediatePropagation();
                // Enter in the name modal saves it
                if (type === "keydown" && e.key === "Enter" && active.id === "rgNameInput") {
                    const saveBtn = document.getElementById("rgNameSave");
                    if (saveBtn && !saveBtn.disabled) saveBtn.click();
                }
            }
        }, true); // capture phase -- runs before the game's own listeners
    });

    // Returns a promise that resolves with the chosen (validated) name.
    // Checks whether a display name is already used by a DIFFERENT player.
    // Best-effort: a Firestore read against existing leaderboard entries. Not
    // race-proof (two people picking the same name simultaneously could both
    // pass), but catches every normal collision.
    async function isNameTaken(fb, name, ownSourceUserId) {
        try {
            const q = fb.query(
                fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                fb.where("name", "==", name)
            );
            const snap = await fb.getDocs(q);
            // Taken only if some matching entry belongs to a different player.
            return snap.docs.some(d => d.data().sourceUserId !== ownSourceUserId);
        } catch (e) {
            // If the check itself fails, don't block the user -- let it through.
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

                // Name-taken check (async). Disable Save while checking.
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
                resolve(null); // no name chosen -> nothing gets submitted this time
            };

            // Key handling (including Enter-to-save) happens in the window-level
            // capture listener above, which runs before the game's own handlers.
        });
    }

    // ---------- Write-reduction caches ----------
    // Together these keep Firebase traffic to the minimum: nothing is read
    // twice per session, and nothing is written unless it actually changed.

    // Running counter logged to console for every real Firestore write.
    let firestoreWriteCount = 0;
    function logWrite(label) {
        firestoreWriteCount++;
        console.log(`[RG HUD] Firestore write #${firestoreWriteCount} (${label})`);
    }

    // Resolved display name per player (skips the getDoc re-read).
    const cachedDisplayNames = new Map();

    // Full payload snapshot per player (skips everything if nothing changed).
    const lastSyncSnapshot = new Map();

    // Real leaderboard doc ID per player+mode (skips the lookup query).
    const knownDocIds = new Map();

    // Safety-net cooldown: max one full sync per player per window.
    const SYNC_COOLDOWN_MS = 20000;
    const lastSyncTime = new Map();

    let forceRenamePrompt = false;

    // Serializes submitToLeaderboard per player so near-simultaneous events
    // can't race each other into double prompts or duplicate writes.
    const submitLocks = new Map();

    async function submitToLeaderboard(data) {
        const lockKey = data.Id;
        const previous = submitLocks.get(lockKey) || Promise.resolve();
        const current = previous.then(() => submitToLeaderboardInner(data));
        submitLocks.set(lockKey, current);
        await current;
    }

    async function submitToLeaderboardInner(data) {
        if (!hasPlayedAnything(data)) return; // brand new account, nothing to show yet

        const fb = await initFirebase();
        if (!fb) return; // disabled or failed to load, silently skip

        const docRef = fb.doc(fb.db, LEADERBOARD_COLLECTION, data.Id);

        // Only ask for a display name once per player, ever -- unless Rename
        // forces it. Cached in memory so repeat calls skip the Firestore read.
        let existingDisplayName = cachedDisplayNames.get(data.Id) ?? null;

        if (!existingDisplayName || forceRenamePrompt) {
            try {
                const existing = await fb.getDoc(docRef);
                if (existing.exists() && existing.data().displayName) {
                    existingDisplayName = existing.data().displayName;
                }
            } catch (e) {
                // couldn't read existing doc -- fall through and ask
            }
        }

        let displayName = (!forceRenamePrompt && existingDisplayName) ? existingDisplayName : null;
        const isRename = forceRenamePrompt && !!existingDisplayName;
        forceRenamePrompt = false;

        if (!displayName) {
            // No saved name yet -- prompt with a suggestion, but a real name is
            // required. If they cancel without entering one, we submit nothing
            // and will ask again next time (no gibberish/default on the board).
            const cleaned = cleanName(data.Nickname).slice(0, 15);
            const suggestion = (cleaned && cleaned.toLowerCase() !== "player") ? cleaned : "";
            displayName = await askDisplayName(suggestion, isRename, fb, data.Id);
            if (!displayName) return; // cancelled without picking a name -- skip this submission
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

        // Make sure clan membership is known before the change check below, so
        // the clan tag can be part of the snapshot (otherwise a first-of-session
        // sync wouldn't know the tag yet).
        if (!clanLoaded || clanLoadedForAccount !== data.Id) {
            await loadClanData(true);
        }

        // Skip the actual network writes if nothing changed or synced very
        // recently -- but never skip a deliberate Rename. The clan tag is part
        // of the snapshot so a clan/tag change (which doesn't touch MMR or stats)
        // still forces a resync instead of being seen as "unchanged".
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
            // Still refresh ranks once per session even if the write is skipped.
            refreshRanks(fb, data);
            return;
        }

        lastSyncSnapshot.set(data.Id, snapshotKey);
        lastSyncTime.set(data.Id, now);

        try {
            logWrite("script_submissions");
            await fb.setDoc(docRef, payload, { merge: true });
            clearError();
        } catch (e) {
            console.error("[RG HUD] Leaderboard submission failed:", e);
            showError("Stats submission failed -- check console");
        }

        await syncToRealLeaderboard(fb, data, displayName);
        refreshRanks(fb, data, true);
        refreshClanViewIfOpen(); // live-update event score/contribution, no extra reads
        applyTitle(); // clan-lead status may have flipped since updateMomentum ran
    }

    const REAL_LEADERBOARD_COLLECTION = "leaderboard";

    // Serializes calls per player+mode so two near-simultaneous writes for the
    // same key can never race each other into creating two documents.
    const upsertLocks = new Map();

    // Finds this player's entry for one playlist by sourceUserId and updates it,
    // whether created by the script OR a pre-existing manually-curated entry Pal
    // tagged with a matching sourceUserId. merge:true means hand-set fields like
    // flag/icons/glowColor are never touched. Creates a fresh entry if none match.
    async function upsertPlaylistEntry(fb, sourceUserId, playlist, fields) {
        const lockKey = `${sourceUserId}_${playlist}`;
        const previous = upsertLocks.get(lockKey) || Promise.resolve();

        const current = previous.then(async () => {
            const cacheKey = `${sourceUserId}_${playlist}`;
            const cachedId = knownDocIds.get(cacheKey);

            try {
                if (cachedId) {
                    logWrite(`leaderboard/${playlist} (cached id)`);
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, cachedId), fields, { merge: true });
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

    // Last-written state per player+playlist. A 3v3 match only changes the 3v3
    // and wins entries, so 1v1/2v2 skip their writes entirely. Backed by
    // sessionStorage so a page refresh doesn't trigger a redundant full burst.
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

    async function syncToRealLeaderboard(fb, data, displayName) {
        const sourceUserId = data.Id;

        // Determine clan tag (if any) to prefix on the leaderboard name, and
        // opportunistically keep the clan's stored MMR for this member current.
        const clanInfo = await updateMyClanMMR(fb, data);
        const shownName = clanInfo?.tag ? `[${clanInfo.tag}] ${displayName}` : displayName;

        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
            const mmr = data.ModesGlicko?.[mode]?.displayRating;
            if (typeof mmr !== "number") continue; // player hasn't played this mode -- skip it
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

    // If this player is in a clan, refresh their stored ranked MMR within the
    // clan's members array and recompute the clan total (one extra write, only
    // for clan members, piggybacked on the match sync). Returns { tag } if in a
    // clan so the caller can prefix the leaderboard name. Best-effort.
    async function updateMyClanMMR(fb, data) {
        const uid = data.Id;
        try {
            // Use cached directory to find my clan cheaply (no extra read if warm).
            if (!clanLoaded || clanLoadedForAccount !== uid) await loadClanData(true);
            if (!myClan) return null;

            // Capture the tag up front -- this is what the leaderboard name needs,
            // and it must NOT depend on the MMR write below succeeding.
            const tag = myClan.tag ?? "";

            const g = data.ModesGlicko;
            const rankedModes = ["Competitive3v3", "Competitive2v2", "Competitive1v1"];
            const myMMR = rankedModes.reduce((s, m) =>
                s + (typeof g?.[m]?.displayRating === "number" ? g[m].displayRating : 0), 0);

            // Load event config (cheap, cached) so we know if a Clan Clash is on.
            await loadEventConfig(fb);

            const prevMine = (myClan.members ?? []).find(m => m.userId === uid)?.mmr;
            if (prevMine !== myMMR) {
                try {
                    const members = (myClan.members ?? []).map(m =>
                        m.userId === uid ? { ...m, mmr: myMMR } : m
                    );
                    const totalMMR = members.reduce((s, m) => s + (m.mmr ?? 0), 0);
                    // Stamp an unforgeable server time; we read it back to learn the
                    // authoritative clock for event-window decisions.
                    await fb.setDoc(fb.doc(fb.db, "clans", myClan.id),
                        { members, totalMMR, lastSyncAt: fb.serverTimestamp() }, { merge: true });
                    myClan.members = members;
                    myClan.totalMMR = totalMMR;

                    // Read back the server time we just wrote, to calibrate serverNow().
                    try {
                        const back = await fb.getDoc(fb.doc(fb.db, "clans", myClan.id));
                        const ts = back.exists() ? back.data().lastSyncAt : null;
                        if (ts?.toMillis) learnServerTime(ts.toMillis());
                    } catch (e) {}

                    await refreshDirectory(fb);
                } catch (writeErr) {
                    // MMR sync is best-effort; a failure here must not strip the tag.
                    console.warn("[RG HUD] Clan MMR write failed (tag still applies):", writeErr);
                }
            }

            // Event baseline: capture this member's starting MMR on their first
            // sync during an active event (uses server-authoritative timing).
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
            return; // nothing about this entry changed -- skip the write entirely
        }

        const ok = await upsertPlaylistEntry(fb, sourceUserId, playlist, fields);
        // Only remember this state if the write actually succeeded -- otherwise a
        // failed write (e.g. rules rejection) would poison the cache and stop us
        // ever retrying with the same data.
        if (ok) {
            lastEntryState.set(stateKey, newState);
            saveEntryState();
        }
    }

    // ---------- Rank lookup ----------
    // Uses Firestore count aggregation: "how many entries in this playlist have
    // a higher mmr than mine" is a single cheap server-side count, not a full
    // collection download. Refreshed after our own data changes (force=true),
    // plus once per session as a baseline; cached in between.

    let ranksFetchedThisSession = false;
    let lastRankRefresh = 0;
    const RANK_REFRESH_COOLDOWN_MS = 60000;

    async function refreshRanks(fb, data, force = false) {
        const now = Date.now();
        if (!force && ranksFetchedThisSession) return;
        if (now - lastRankRefresh < RANK_REFRESH_COOLDOWN_MS && ranksFetchedThisSession) return;

        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        try {
            for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
                const mmr = data.ModesGlicko?.[mode]?.displayRating;
                if (typeof mmr !== "number") continue;

                const q = fb.query(
                    fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                    fb.where("playlist", "==", playlist),
                    fb.where("mmr", ">", mmr)
                );
                const snapshot = await fb.getCountFromServer(q);
                const rank = snapshot.data().count + 1;
                cachedRanks.set(playlist, rank);

                // Gap to next rank up: fetch the lowest-MMR entry still above us
                // (the one directly ahead). Skipped entirely when already #1.
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
                        // gap is a nice-to-have on top of rank -- ignore if it fails
                    }
                } else {
                    cachedMmrToNext.delete(playlist);
                }
            }

            ranksFetchedThisSession = true;
            lastRankRefresh = now;

            checkRankTransitions();

            // Re-render with fresh ranks
            if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
        } catch (e) {
            // Rank display is nice-to-have -- never let it break anything else.
            console.warn("[RG HUD] Rank lookup failed:", e);
        }
    }

    // ---------- Network capture ----------

    // Track the currently equipped skin so partial-response endpoints (equipSkin) can update it
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

            // Only fires when a real match with real teams is forming --
            // never for an empty party or just sitting in a lobby.
            if (arg.includes("[PlayerDataManager] Initialized stats for player")) {
                setAutoVisible(false);
            }

            // Back in a party/lobby room means not mid-match anymore.
            // Catches early-quit cases where matchEnd never fires.
            if (arg.includes("OnJoinedRoom Party")) {
                setAutoVisible(true);
            }
        }
    };

    // ---------- Clan events (Clan Clash) ----------
    // Event config lives in Firestore (events/current), editable by admin only,
    // so events can be scheduled/rescheduled without a script update. Timing uses
    // Firestore serverTimestamp() -- unforgeable, immune to device-clock spoofing.
    // Each member's baseline MMR is captured on THEIR first sync after the event
    // starts (fresh, not stale); event score = sum of (current - baseline) across
    // members, which can go negative.

    let eventConfig = null;       // { name, startTime(ms), endTime(ms) } or null
    let eventConfigLoaded = false;
    let serverNowOffset = null;   // (serverTime - deviceTime) learned from a write, ms

    async function loadEventConfig(fb, force = false) {
        if (eventConfigLoaded && !force) return eventConfig;
        try {
            const snap = await fb.getDoc(fb.doc(fb.db, "events", "current"));
            if (snap.exists()) {
                const d = snap.data();
                eventConfig = {
                    name: d.name ?? "Clan Event",
                    startTime: d.startTime?.toMillis ? d.startTime.toMillis() : (d.startTime ?? 0),
                    endTime: d.endTime?.toMillis ? d.endTime.toMillis() : (d.endTime ?? 0),
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

    // Best estimate of authoritative server time. We learn an offset from device
    // time whenever a write round-trips a serverTimestamp; until then we fall back
    // to device time (only affects the cosmetic countdown, never scoring).
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

    // Capture this member's baseline the first time they sync during an active
    // event. Stored on the clan doc: eventBaseline[userId] = mmrAtFirstSync.
    // A stable id for the current event window, so baselines from a previous
    // event are recognized as stale and re-captured rather than reused.
    function currentEventId() {
        return eventConfig ? String(eventConfig.startTime) : null;
    }

    async function maybeCaptureEventBaseline(fb, uid, currentMMR) {
        if (!myClan || eventPhase() !== "active") return;
        const evId = currentEventId();

        // If the stored baseline belongs to a different (old) event, wipe it so
        // this event starts fresh for everyone.
        let baseline = myClan.eventBaseline ?? {};
        if (myClan.eventId !== evId) {
            baseline = {}; // stale from a previous event -- reset
        }
        if (baseline[uid] != null && myClan.eventId === evId) return; // already captured this event

        try {
            baseline[uid] = currentMMR;
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id),
                { eventBaseline: baseline, eventId: evId, eventName: eventConfig.name }, { merge: true });
            myClan.eventBaseline = baseline;
            myClan.eventId = evId;
        } catch (e) {
            console.warn("[RG HUD] Event baseline capture failed:", e);
        }
    }

    // A clan's baseline only counts if it belongs to the current event.
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

    // Human-readable "2d 3h 14m" style countdown from now until target ms.
    function formatCountdown(targetMs) {
        let ms = targetMs - serverNow();
        if (ms < 0) ms = 0;
        const d = Math.floor(ms / 86400000);
        const h = Math.floor((ms % 86400000) / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        if (d > 0) return `${d}d ${h}h ${m}m`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    // Standings for the current event, ranked by eventScore desc. Only clans
    // whose baseline belongs to the current event count.
    function eventStandings() {
        const evId = currentEventId();
        return clanDirectory
            .filter(c => c.eventId === evId)
            .slice()
            .sort((a, b) => (b.eventScore ?? 0) - (a.eventScore ?? 0));
    }

    // True if there's an active event AND our clan is #1 in the current
    // standings. Drives the "👑 Leading the Clash" HUD title, mirroring the
    // "👑 Rocket Goal KING" treatment used for individual-mode #1s.
    function isMyClanLeadingClash() {
        if (eventPhase() !== "active") return false;
        if (!myClan) return false;
        const standings = eventStandings();
        return standings.length > 0 && standings[0].id === myClan.id;
    }

    // Builds the event banner HTML for the clan tab. `clan` may be null (shown to
    // clanless players too, minus the personal/score bits). Returns "" if no event.
    // Layout: header row (title + countdown) then a two-column body during active
    // phase. Left column = your clan's numbers, right column = leader or challenger.
    function eventBannerHtml(clan, uid) {
        const phase = eventPhase();
        if (phase === "none") return "";

        const gold = "#ffd700";
        const standings = eventStandings();
        const leader = standings[0];

        // Header row: title left, countdown/status right -- one line, always.
        let statusRight = "";
        if (phase === "upcoming")   statusRight = `Starts in ${formatCountdown(eventConfig.startTime)}`;
        else if (phase === "active") statusRight = `${formatCountdown(eventConfig.endTime)} left`;
        else                         statusRight = `Ended`;

        const header = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <div style="font-weight:bold;color:${gold};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🏆 ${escapeHtml(eventConfig.name)}</div>
                <div style="font-size:10px;opacity:.8;white-space:nowrap;flex-shrink:0;">${statusRight}</div>
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

                // Rank badge with hover tooltip -- mirrors the main-HUD rankBadge
                // pattern but on clan-event standings. Tooltip shows event-score
                // (MMR delta) needed to catch the clan directly above you.
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
                    // Show total ("of N") only when there's actually competition;
                    // "#1/1" is meaningless clutter when you're alone in the event.
                    const totalPart = standings.length > 1
                        ? `<span style="opacity:.55;font-weight:normal;"> of ${standings.length}</span>`
                        : "";
                    rankBadgeHtml = `<span class="rgHasTip" data-tip="${tip}" style="color:${rankColor};font-weight:bold;font-size:11px;">#${myRank}${totalPart}</span>`;
                }

                // Left column: your clan's numbers.
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

                // Right column: leader (if not you) or challenger (if you lead) or lonely-message.
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
                // Clanless viewer: single line showing who's on top.
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

    const CLAN_MAX_MEMBERS = 5;

    function myUserId() { return lastKnownPlayerData?.Id ?? null; }
    function myName() {
        return cachedDisplayNames.get(myUserId()) || cleanName(lastKnownPlayerData?.Nickname) || "Unknown";
    }

    // Roles that can approve/reject join requests.
    function canManageRequests(role) {
        return role === "leader" || role === "coleader" || role === "elder";
    }

    async function loadClanData(force = false) {
        const uid = myUserId();
        if (!uid) return;

        // Account changed since last load -> force a fresh load and clear stale state.
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
            // Directory: one read for the browse list.
            const dirSnap = await fb.getDoc(fb.doc(fb.db, "clans_directory", "index"));
            clanDirectory = dirSnap.exists() ? (dirSnap.data().clans ?? []) : [];

            // Find my clan (if any) by scanning the directory for my membership.
            myClan = null;
            const mine = clanDirectory.find(c => (c.memberIds ?? []).includes(uid));
            if (mine) {
                const clanSnap = await fb.getDoc(fb.doc(fb.db, "clans", mine.id));
                if (clanSnap.exists()) myClan = { id: mine.id, ...clanSnap.data() };
            }
            clanLoaded = true;
            clanLoadedForAccount = uid;
        } catch (e) {
            console.warn("[RG HUD] Clan load failed:", e);
        }
    }

    // Rebuild the directory doc from scratch off current clans -- simple and
    // safe for a small number of clans. Called after any membership change.
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
                    memberCount: (d.members ?? []).length,
                    memberIds: (d.members ?? []).map(m => m.userId),
                    totalMMR: d.totalMMR ?? 0,
                    // Event score for the current event (0 if their baseline is
                    // stale/absent), so standings can rank clans by event gain.
                    eventScore: computeClanEventScore({ ...d, id: docSnap.id }),
                    eventId: d.eventId ?? null,
                });
            });
            await fb.setDoc(fb.doc(fb.db, "clans_directory", "index"), { clans });
            clanDirectory = clans;
        } catch (e) {
            console.warn("[RG HUD] Directory refresh failed:", e);
        }
        // Directory drives the clan-lead HUD title; refresh it so any standings
        // change flips the title in/out of "Leading the Clash" immediately.
        applyTitle();
    }

    // Sum of this player's 3v3+2v2+1v1 displayRatings (no casual).
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

        // Uniqueness check against directory (best-effort).
        if (clanDirectory.some(c => c.name.toLowerCase() === name.toLowerCase())) {
            showToast("A clan with that name already exists.");
            return;
        }

        try {
            const clan = {
                name,
                tag: tag || "",
                leaderId: uid,
                members: [{ userId: uid, name: myName(), role: "leader" }],
                joinRequests: [],
                totalMMR: myRankedMMR(),
                createdAt: new Date().toISOString(),
            };
            const ref = await fb.addDoc(fb.collection(fb.db, "clans"), clan);
            myClan = { id: ref.id, ...clan };
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Create clan failed:", e);
            showToast("Couldn't create clan (see console).");
        }
    }

    async function requestJoin(clanId) {
        const fb = await initFirebase();
        if (!fb) return;
        const uid = myUserId();
        if (!uid) return;

        try {
            const clanSnap = await fb.getDoc(fb.doc(fb.db, "clans", clanId));
            if (!clanSnap.exists()) return;
            const clan = clanSnap.data();

            if ((clan.members ?? []).length >= CLAN_MAX_MEMBERS) {
                showToast("That clan is full.");
                return;
            }
            if ((clan.joinRequests ?? []).some(r => r.userId === uid)) {
                showToast("You already requested to join.");
                return;
            }
            const joinRequests = [...(clan.joinRequests ?? []), { userId: uid, name: myName() }];
            await fb.setDoc(fb.doc(fb.db, "clans", clanId), { joinRequests }, { merge: true });
            showToast("Join request sent!");
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Request join failed:", e);
        }
    }

    async function approveRequest(userId, approve) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;

        try {
            const req = (myClan.joinRequests ?? []).find(r => r.userId === userId);
            const joinRequests = (myClan.joinRequests ?? []).filter(r => r.userId !== userId);
            let members = myClan.members ?? [];

            if (approve && req && members.length < CLAN_MAX_MEMBERS
                && !members.some(m => m.userId === userId)) {
                members = [...members, { userId: req.userId, name: req.name, role: "member" }];
            }

            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { joinRequests, members }, { merge: true });
            myClan.joinRequests = joinRequests;
            myClan.members = members;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Approve request failed:", e);
        }
    }

    async function kickMember(userId, message) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();

        try {
            const target = (myClan.members ?? []).find(m => m.userId === userId);
            if (!target || target.role === "leader") return; // never kick the leader
            // Only leader/coleader may kick (defense in depth beyond the UI gating).
            const me = (myClan.members ?? []).find(m => m.userId === myUid);
            if (!me || (me.role !== "leader" && me.role !== "coleader")) return;

            const members = (myClan.members ?? []).filter(m => m.userId !== userId);
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            myClan.members = members;

            // Leave a one-time notice the kicked player's HUD will show + clear.
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
            console.error("[RG HUD] Kick failed:", e);
            showToast("Couldn't kick member (see console).");
        }
    }

    // On load, check if this player has a pending clan notice (e.g. was kicked)
    // and show it once, then clear it.
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

    // ---------- Role management (Stage 2) ----------
    // Hierarchy: leader > coleader > elder > member. Clash-style: multiple
    // coleaders/elders allowed. Permission gating (who can change whom) is
    // enforced here in-script (honor system).

    const ROLE_RANK = { leader: 3, coleader: 2, elder: 1, member: 0 };

    // Can `actorRole` set `targetCurrentRole` to `newRole`?
    function canSetRole(actorRole, targetCurrentRole, newRole) {
        const a = ROLE_RANK[actorRole] ?? -1;
        // Only leader/coleader manage roles at all.
        if (a < ROLE_RANK.coleader) return false;
        // Can't touch someone at or above your own rank (coleader can't touch coleader/leader).
        if ((ROLE_RANK[targetCurrentRole] ?? 0) >= a) return false;
        // Can't promote someone to at/above your own rank.
        if ((ROLE_RANK[newRole] ?? 0) >= a) return false;
        // Nobody assigns "leader" via this path -- that's transferLeadership only.
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

        if (!canSetRole(me.role, target.role, newRole)) {
            showToast("You can't change that member's role.");
            return;
        }

        try {
            const members = (myClan.members ?? []).map(m =>
                m.userId === userId ? { ...m, role: newRole } : m
            );
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            myClan.members = members;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Set role failed:", e);
            showToast("Couldn't change role (see console).");
        }
    }

    async function editClan(newName, newTag) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        if (myClan.leaderId !== myUserId()) return; // leader only

        // Uniqueness (ignore our own clan).
        const nameClash = clanDirectory.some(c => c.id !== myClan.id && (c.name ?? "").toLowerCase() === newName.toLowerCase());
        const tagClash = clanDirectory.some(c => c.id !== myClan.id && (c.tag ?? "").toLowerCase() === newTag.toLowerCase());
        if (nameClash) { showToast("A clan with that name already exists."); return; }
        if (tagClash) { showToast("That tag is already taken."); return; }

        try {
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { name: newName, tag: newTag }, { merge: true });
            myClan.name = newName;
            myClan.tag = newTag;
            await refreshDirectory(fb);
            showToast("Clan updated! Tag refreshes on members' next match.");
            renderClanView();
        } catch (e) {
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
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;user-select:text;">
                <div id="rgEditErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
                <div style="display:flex;gap:6px;">
                    <button id="rgEditGo" class="rgBtn" style="flex:1;">Save</button>
                    <button id="rgEditCancel" class="rgBtn" style="flex:1;">Cancel</button>
                </div>
            </div>`;

        const errEl = document.getElementById("rgEditErr");
        document.getElementById("rgEditGo").onclick = () => {
            const name = document.getElementById("rgEditName").value.trim();
            const tag = document.getElementById("rgEditTag").value.trim();
            if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
            if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag must be 2-4 characters."; return; }
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
        if (myClan.leaderId !== myUid) return; // only the leader can transfer

        try {
            const members = (myClan.members ?? []).map(m => {
                if (m.userId === userId) return { ...m, role: "leader" };
                if (m.userId === myUid) return { ...m, role: "coleader" }; // old leader -> coleader
                return m;
            });
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members, leaderId: userId }, { merge: true });
            myClan.members = members;
            myClan.leaderId = userId;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Transfer leadership failed:", e);
            showToast("Couldn't transfer leadership (see console).");
        }
    }

    async function leaveClan() {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const uid = myUserId();

        try {
            const isLeader = myClan.leaderId === uid;
            if (isLeader && (myClan.members ?? []).length > 1) {
                showToast("Transfer leadership or remove others before leaving.");
                return;
            }
            if (isLeader) {
                // Last member & leader -> disband.
                await fb.deleteDoc(fb.doc(fb.db, "clans", myClan.id));
            } else {
                const members = (myClan.members ?? []).filter(m => m.userId !== uid);
                await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            }
            myClan = null;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Leave clan failed:", e);
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
        if (fb) await loadEventConfig(fb, true);

        renderClanViewFromMemory();
    }

    // Re-renders the clan tab from whatever's already in myClan/clanDirectory --
    // no Firestore reads. Called after a match sync (which already refreshed
    // myClan in memory) so the event score updates live, piggybacking on data
    // we already have instead of reading again.
    function renderClanViewFromMemory() {
        const view = document.getElementById("rgClanView");
        if (!view) return;
        myClan ? renderMyClan(view) : renderNoClan(view);
    }

    // If the clan tab is currently open, refresh it in place (no reads).
    function refreshClanViewIfOpen() {
        const view = document.getElementById("rgClanView");
        if (view && view.style.display !== "none") {
            renderClanViewFromMemory();
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
                        ${c.tag ? `<span style="opacity:.7;">[${c.tag}]</span>` : ""}
                        <b>${escapeHtml(c.name)}</b>
                        <span style="opacity:.6;font-size:10px;">(${c.memberCount}/${CLAN_MAX_MEMBERS})</span>
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                        <span style="color:#00ff66;font-size:11px;">${c.totalMMR}</span>
                        <button class="rgBtn rgJoinBtn" data-clan="${c.id}" style="padding:2px 6px;font-size:10px;" ${c.memberCount >= CLAN_MAX_MEMBERS ? "disabled" : ""}>Join</button>
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
            btn.onclick = () => requestJoin(btn.getAttribute("data-clan"));
        });
    }

    function showCreateClanForm() {
        const view = document.getElementById("rgClanView");
        view.innerHTML = `
            <b>Create a Clan</b>
            <div style="margin-top:8px;">
                <input type="text" id="rgClanName" placeholder="Clan name (max 24)" maxlength="24"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;margin-bottom:6px;user-select:text;">
                <input type="text" id="rgClanTag" placeholder="Tag (2-4 chars, required)" maxlength="4"
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
        [nameEl, tagEl].forEach(el => {
            el.addEventListener("keydown", e => e.stopPropagation(), true);
        });

        document.getElementById("rgClanCreateGo").onclick = () => {
            const name = nameEl.value.trim();
            const tag = tagEl.value.trim();
            if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
            if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag is required (2-4 characters)."; return; }
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

        // Leaders and co-leaders can kick + manage roles. Can't act on yourself or the leader.
        const canManage = (myRole === "leader" || myRole === "coleader");
        const memberRows = (myClan.members ?? [])
            .slice()
            .sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0))
            .map(m => {
                const actable = canManage && m.userId !== uid && m.role !== "leader"
                    && (ROLE_RANK[m.role] ?? 0) < (ROLE_RANK[myRole] ?? 0);
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${escapeHtml(m.name)}
                        ${typeof m.mmr === "number" ? `<span style="opacity:.5;font-size:10px;">${m.mmr}</span>` : ""}
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
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
                    ${isLeader ? `<button id="rgEditClan" class="rgBtn" style="padding:1px 6px;font-size:10px;">✏️</button>` : ""}
                    <span style="color:#ffd700;font-size:11px;">Rank #${rank || "-"}</span>
                </span>
            </div>
            <div style="font-size:11px;opacity:.75;margin:2px 0 6px;">
                Total MMR: <span style="color:#00ff66;">${myClan.totalMMR ?? 0}</span>
                &nbsp;•&nbsp; ${(myClan.members ?? []).length}/${CLAN_MAX_MEMBERS} members
            </div>
            <div id="rgMembersHeader" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:2px 0;margin-top:2px;">
                <span id="rgMembersArrow" style="font-size:9px;opacity:.7;width:8px;display:inline-block;">▶</span>
                <b>Members</b>
            </div>
            <div id="rgMembersList" style="display:none;">${memberRows}</div>
            ${requestsSection}
            <button id="rgLeaveClan" class="rgBtn" style="width:100%;margin-top:8px;">Leave Clan</button>
        `;

        if (isLeader) {
            const editBtn = document.getElementById("rgEditClan");
            if (editBtn) editBtn.onclick = showEditClanForm;
        }

        // Members list is collapsed by default to reserve HUD vertical space;
        // clicking the header (or the little arrow) toggles it.
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

        view.querySelectorAll(".rgApprove").forEach(b => b.onclick = () => approveRequest(b.getAttribute("data-uid"), true));
        view.querySelectorAll(".rgReject").forEach(b => b.onclick = () => approveRequest(b.getAttribute("data-uid"), false));
        view.querySelectorAll(".rgManage").forEach(b => b.onclick = async () => {
            const tUid = b.getAttribute("data-uid");
            const tName = b.getAttribute("data-name");
            const tRole = b.getAttribute("data-role");
            await showManageMemberMenu(tUid, tName, tRole, myRole, myClan.leaderId === uid);
        });
        document.getElementById("rgLeaveClan").onclick = async () => {
            const sure = await showDialog({ message: "Leave this clan?", okLabel: "Leave", cancelLabel: "Cancel" });
            if (sure) leaveClan();
        };
    }

    // Themed replacements for native alert/confirm/prompt.
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

    // Themed confirm/prompt. Returns a promise:
    //  - confirm mode -> resolves true/false
    //  - prompt mode  -> resolves the string, or null if cancelled
    function showDialog({ message, withInput = false, inputPlaceholder = "", okLabel = "OK", cancelLabel = "Cancel" }) {
        return new Promise(resolve => {
            createHUD();
            const dlg = document.getElementById("rgDialog");
            const msgEl = document.getElementById("rgDialogMsg");
            const input = document.getElementById("rgDialogInput");
            const okBtn = document.getElementById("rgDialogOk");
            const cancelBtn = document.getElementById("rgDialogCancel");

            msgEl.textContent = message;
            okBtn.textContent = okLabel;
            cancelBtn.textContent = cancelLabel;
            input.style.display = withInput ? "block" : "none";
            input.value = "";
            input.placeholder = inputPlaceholder;
            dlg.style.display = "flex";
            if (withInput) setTimeout(() => input.focus(), 50);

            const close = result => {
                dlg.style.display = "none";
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                resolve(result);
            };
            okBtn.onclick = () => close(withInput ? input.value.trim() : true);
            cancelBtn.onclick = () => close(withInput ? null : false);
        });
    }

    // A small action menu for managing one member -- rendered into the clan view
    // temporarily. Options depend on the actor's role and the target's role.
    async function showManageMemberMenu(userId, name, targetRole, actorRole, actorIsLeader) {
        const view = document.getElementById("rgClanView");
        if (!view) return;

        // Build the list of allowed actions.
        const actions = [];
        // Role changes: offer any role strictly below the actor that isn't the current one.
        const assignable = ["coleader", "elder", "member"].filter(r =>
            r !== targetRole && canSetRole(actorRole, targetRole, r)
        );
        for (const r of assignable) {
            const verb = (ROLE_RANK[r] > ROLE_RANK[targetRole]) ? "Promote to" : "Demote to";
            actions.push({ label: `${verb} ${r}`, run: () => setMemberRole(userId, r) });
        }
        // Transfer leadership: leader only.
        if (actorIsLeader) {
            actions.push({ label: "👑 Transfer leadership", danger: true, run: async () => {
                const sure = await showDialog({
                    message: `Make ${name} the clan leader? You'll become co-leader.`,
                    okLabel: "Transfer", cancelLabel: "Cancel",
                });
                if (sure) transferLeadership(userId);
            }});
        }
        // Kick.
        actions.push({ label: "❌ Kick from clan", danger: true, run: async () => {
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

    // ---------- Boot ----------

    const wait = setInterval(() => {
        if (document.body) {
            clearInterval(wait);
            createHUD();
            console.log("[RG HUD] loaded and running, waiting for login/matchEnd data...");
        }
    }, 100);

})();
