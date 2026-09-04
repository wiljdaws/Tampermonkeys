export function tickCountdown() {
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


// `clan` may be null (clanless players see the banner without their numbers).
// returns "" when there's no event.
export const DEFAULT_POST_EVENT_GRACE_MS = 48 * 60 * 60 * 1000;

export function eventBannerHtml(clan, uid) {
    const phase = eventPhase();
    if (phase === "none") return "";
    // Hide the "Ended" banner once the grace window closes so it
    // doesn't sit forever between events.
    if (phase === "ended") {
        const grace = typeof eventConfig?.postEventGracePeriodMs === "number"
            ? eventConfig.postEventGracePeriodMs
            : DEFAULT_POST_EVENT_GRACE_MS;
        if (serverNow() > eventConfig.endTime + grace) return "";
    }

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


export async function clanNameReservationId(name) {
    const bytes = new TextEncoder().encode(normalizeClanName(name));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
        .map(value => value.toString(16).padStart(2, "0"))
        .join("");
}


export function clanDirectoryDocRef(fb, clanId) {
    return clanReservationsEnabled()
        ? fb.doc(fb.db, "clans_directory", clanId)
        : fb.doc(fb.db, "clans_directory", "index");
}


// sum of 3v3+2v2+1v1 displayRatings (no casual)
export function myRankedMMR() {
    const g = lastKnownPlayerData?.ModesGlicko;
    const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1"];
    return modes.reduce((s, m) => s + (typeof g?.[m]?.displayRating === "number" ? g[m].displayRating : 0), 0);
}


export function getClanTagPrefix() {
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
