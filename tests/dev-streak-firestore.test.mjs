import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

const firebaseWorkspace = process.env.FIREBASE_WORKSPACE;
assert.ok(firebaseWorkspace, "FIREBASE_WORKSPACE is required");
const requireFromFirebase = createRequire(
  path.join(firebaseWorkspace, "package.json"),
);
const {
  assertSucceeds,
  initializeTestEnvironment,
} = requireFromFirebase("@firebase/rules-unit-testing");
const {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} = requireFromFirebase("firebase/firestore");
const rules = await readFile(
  path.join(firebaseWorkspace, "firestore.rules"),
  "utf8",
);

let environment;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: "demo-rgleaderboard",
    firestore: { rules },
  });
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "admin", "blacklist"), {
      userIds: [],
      deviceIds: [],
      minVersion: 16.0,
    });
  });
});

after(async () => {
  await environment.cleanup();
});

function submission(versionNum, overrides = {}) {
  return {
    sourceUserId: "streak-player",
    nickname: "Streak Player",
    displayName: "Streak Player",
    ratings: {
      Competitive1v1: 1200,
      Competitive2v2: 1300,
      Competitive3v3: 1400,
      Casual: 500,
    },
    stats: {
      Competitive2v2: { wins: 30, matchesPlayed: 50 },
    },
    deviceId: "streak-device",
    scriptVersion: `${versionNum}-dev`,
    versionNum,
    lastWriteAt: serverTimestamp(),
    ...overrides,
  };
}

test("dev streak piggybacks on the existing public submission write", async () => {
  const db = environment.unauthenticatedContext().firestore();
  const reference = doc(db, "script_submissions", "streak-player");
  await assertSucceeds(setDoc(reference, submission(16.4, {
    currentStreak: 8,
  })));
  assert.equal((await getDoc(reference)).data().currentStreak, 8);

  await assertSucceeds(setDoc(reference, submission(16.2, {
    stats: {
      Competitive2v2: { wins: 31, matchesPlayed: 52 },
    },
  }), { merge: true }));
  const merged = (await getDoc(reference)).data();
  assert.equal(merged.currentStreak, 8);
  assert.equal(merged.versionNum, 16.2);
});
