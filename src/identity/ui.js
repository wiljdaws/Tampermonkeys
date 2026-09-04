
export async function lookupDisplayNameFromBoard(fb, rgPlayerId) {
    if (!fb || !rgPlayerId) return "";
    try {
        const q = fb.query(
            fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
            fb.where("rgPlayerId", "==", rgPlayerId),
            fb.limit(8)
        );
        const snap = await fb.getDocs(q);
        return boardIdentityFromDocs(snap.docs.map((d) => d.data()), rgPlayerId).displayName;
    } catch (e) {
        dbg("lookupDisplayNameFromBoard failed: " + getErrMsg(e));
        return "";
    }
}


// best-effort collision check. two simultaneous picks could both pass,
// but that's rare enough to live with.
export async function isNameTaken(fb, name, firebaseUid, rgPlayerId) {
    try {
        const q = fb.query(
            fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
            fb.where("name", "==", name),
            fb.limit(8)
        );
        const snap = await fb.getDocs(q);
        return isNameTakenByOthers(
            snap.docs.map((d) => d.data()),
            firebaseUid,
            rgPlayerId,
        );
    } catch (e) {
        // don't block on check failure, let it through
        dbg("isNameTaken check failed (letting through): " + getErrMsg(e));
        console.warn("[RG HUD] Name availability check failed:", e);
        return false;
    }
}


export function askDisplayName(suggestion, isRename, fb, firebaseUid, rgPlayerId) {
    return new Promise(resolve => {
        const title = isRename
            ? "Enter your new leaderboard name:"
            : "Pick your leaderboard name to appear on the board:";
        showNameModal(title, suggestion, true, resolve);

        const input = document.getElementById("rgNameInput");
        const errEl = document.getElementById("rgNameError");
        const saveBtn = document.getElementById("rgNameSave");

        saveBtn.onclick = async () => {
            try {
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
                const taken = fb ? await isNameTaken(fb, entered, firebaseUid, rgPlayerId) : false;
                saveBtn.disabled = false;
                errEl.style.color = "#ff6b6b";

                if (taken) {
                    errEl.textContent = "That name is already taken. Pick another.";
                    return;
                }

                errEl.textContent = "";
                hideNameModal();
                resolve(entered);
            } catch (e) {
                dbg("askDisplayName save handler threw: " + getErrMsg(e));
                saveBtn.disabled = false;
                errEl.style.color = "#ff6b6b";
                errEl.textContent = "Something went wrong. Try again.";
            }
        };

        document.getElementById("rgNameCancel").onclick = () => {
            hideNameModal();
            resolve(null); // cancel -> skip this submission
        };

        // Enter-to-save is wired in the window capture listener above
    });
}

export function showToast(msg) {
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
export function showDialog({ message, withInput = false, inputPlaceholder = "", okLabel = "OK", cancelLabel = "Cancel" }) {
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
        // preserve line breaks for multi-line dialog messages
        msgEl.style.whiteSpace = "pre-wrap";
        okBtn.textContent = okLabel;
        cancelBtn.textContent = cancelLabel;
        // empty label -> no phantom cancel button on info dialogs
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
