#!/usr/bin/env node
// Read from rocketgoal.io's Firebase project (rocketball-23c12) as an
// anonymous client, using the same public config the game ships in its HTML.
// Only surfaces documents whose security rules permit anon reads. If a
// collection returns "PERMISSION_DENIED" it means Rocket Goal has that
// collection gated behind uid-scoped rules, and we stop there.
//
// Usage:
//   node tools/rocketball-read.mjs <collection> [--limit 10]
//   node tools/rocketball-read.mjs leaderboard --limit 5
//   node tools/rocketball-read.mjs users/<uid>       (a specific doc path)
//
// Requires: node 20+, `npm i firebase` in the tools directory.

import { initializeApp } from "firebase/app";
import {
  getAuth, signInAnonymously,
} from "firebase/auth";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, limit,
} from "firebase/firestore";

const CONFIG = {
  apiKey: "AIzaSyCV0DTWtAUgMRA6nvz2CZjTZfDXEyPAF-8",
  authDomain: "rocketball-23c12.firebaseapp.com",
  projectId: "rocketball-23c12",
  storageBucket: "rocketball-23c12.firebasestorage.app",
  messagingSenderId: "263108080315",
  appId: "1:263108080315:web:6e010294b1c6ed3ff42f9e",
};

function parseArgs(argv) {
  const args = { path: null, limit: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit") args.limit = Number(argv[++i]);
    else if (!args.path) args.path = a;
  }
  if (!args.path) {
    console.error("usage: rocketball-read.mjs <collection|doc-path> [--limit N]");
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = initializeApp(CONFIG);
  const auth = getAuth(app);
  const db = getFirestore(app);

  try {
    const cred = await signInAnonymously(auth);
    console.error(`[auth] signed in anonymously as ${cred.user.uid}`);
  } catch (err) {
    console.error(`[auth] anonymous sign-in failed: ${err.code || err.message}`);
    console.error("       If code is auth/admin-restricted-operation, anonymous");
    console.error("       auth is disabled on rocketball-23c12. You'll only be");
    console.error("       able to read data whose rules allow unauthenticated reads.");
  }

  const segments = args.path.split("/").filter(Boolean);
  const isDoc = segments.length % 2 === 0;

  try {
    if (isDoc) {
      const snap = await getDoc(doc(db, args.path));
      if (!snap.exists()) {
        console.log(JSON.stringify({ path: args.path, exists: false }, null, 2));
        return;
      }
      console.log(JSON.stringify({ path: snap.ref.path, data: snap.data() }, null, 2));
    } else {
      const q = query(collection(db, args.path), limit(args.limit));
      const snap = await getDocs(q);
      const rows = [];
      snap.forEach(d => rows.push({ id: d.id, data: d.data() }));
      console.log(JSON.stringify({ collection: args.path, count: rows.length, rows }, null, 2));
    }
  } catch (err) {
    console.error(`[read] failed: ${err.code || err.message}`);
    if (String(err.code || err.message).includes("permission")) {
      console.error("       Collection is not readable to your current auth state.");
      console.error("       That's Firestore rules working as intended, not a bug.");
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error("fatal:", err);
  process.exit(1);
});
