
// ---------- Device ID ----------
// Per-install UUID. Tampermonkey storage keeps it across a site-data
// wipe so the allow-list bind does not break when Auth is restored.

export const DEVICE_ID_KEY = "rgHudDeviceId";


export function readStoredDeviceId(storage) {
    if (!storage || typeof storage.get !== "function") return "";
    try {
        const id = storage.get(DEVICE_ID_KEY);
        return typeof id === "string" ? id.trim() : "";
    } catch (e) {
        return "";
    }
}


export function writeStoredDeviceId(storage, id) {
    if (!storage || typeof storage.set !== "function" || !id) return;
    try { storage.set(DEVICE_ID_KEY, id); } catch (e) {}
}


export function mintDeviceId() {
    return crypto.randomUUID?.()
        || (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12));
}


export function originDeviceStorage() {
    try {
        if (!localStorage) return null;
        return {
            get: (key) => localStorage.getItem(key),
            set: (key, value) => { localStorage.setItem(key, value); },
        };
    } catch (e) {
        return null;
    }
}


export function getDeviceId() {
    const tm = atlasTmStorage();
    const origin = originDeviceStorage();
    let id = readStoredDeviceId(tm) || readStoredDeviceId(origin);
    if (!id) id = mintDeviceId();
    writeStoredDeviceId(origin, id);
    writeStoredDeviceId(tm, id);
    return id;
}
