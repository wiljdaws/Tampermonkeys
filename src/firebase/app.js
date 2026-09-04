export const ATLAS_FIREBASE_APP_NAME = "atlas";


// 19.9 used the default app. 20.0 always created a named "atlas" app,
// which cannot see the existing anonymous session and then treated a
// failed sign-in as "ready", so Settings retry was a no-op.
export function resolveAtlasFirebaseApp(existingApps, config, initializeApp) {
    const apps = Array.isArray(existingApps) ? existingApps : [];
    const named = apps.find((app) => app && app.name === ATLAS_FIREBASE_APP_NAME);
    if (named) return named;
    const def = apps.find((app) => app && app.name === "[DEFAULT]");
    if (!def) return initializeApp(config);
    if (def.options && def.options.projectId === config.projectId) return def;
    return initializeApp(config, ATLAS_FIREBASE_APP_NAME);
}


export function firebaseAuthShouldRetry(uid) {
    return !uid;
}
