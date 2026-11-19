// Shared setup for the Firebase tests. Run under the emulators:
//   npm run test:firebase   (wraps firebase emulators:exec)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInAnonymously } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, terminate } from "firebase/firestore";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { firebaseTransport } from "../../firebase.mjs";

export const PROJECT = "demo-annotate";
export const RULES = fileURLToPath(new URL("../../examples/firebase/firestore.rules", import.meta.url));
const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

let env, counter = 0;
export async function testEnv() {
  if (!env) {
    env = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: await readFile(RULES, "utf8"), host: fsHost, port: Number(fsPort) },
    });
  }
  return env;
}
export async function cleanup() {
  for (const u of users) { try { await terminate(u.db); } catch {} }
  users.length = 0;
  if (env) { await env.cleanup(); env = null; }
}
export const uniqueReview = (prefix = "rvw") => `${prefix}_${Date.now().toString(36)}${counter++}`;

// Seeds documents with the rules switched off (the console / Admin SDK path).
export async function seed(fn) {
  const e = await testEnv();
  await e.withSecurityRulesDisabled(async (ctx) => { await fn(ctx.firestore()); });
}
export async function seedReview(reviewId, data = { name: "Review", open: true }, members = {}) {
  const { doc, setDoc } = await import("firebase/firestore");
  await seed(async (db) => {
    await setDoc(doc(db, "annotateReviews", reviewId), data);
    for (const [uid, m] of Object.entries(members)) await setDoc(doc(db, "annotateReviews", reviewId, "members", uid), m);
  });
}

const users = [];
// A signed-in browser: its own Firebase app, so its own auth state.
export async function makeUser(reviewId, { name } = {}) {
  const app = initializeApp({ projectId: PROJECT, apiKey: "fake" }, `u${counter++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, fsHost, Number(fsPort));
  await signInAnonymously(auth);
  const user = { app, auth, db, uid: auth.currentUser.uid, name, transport: firebaseTransport({ app, reviewId, firestore: db, auth }) };
  users.push(user);
  return user;
}
export const call = async (u, method, path, body) => {
  const res = await u.transport.request(method, path, { body, headers: {} });
  const text = res.status === 204 ? "" : await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};

export function wire(id, page, extra = {}) {
  const now = new Date().toISOString();
  return {
    schema: 2, id, page, url: "http://localhost/" + page, type: "pin", author: "Ann", authorId: null, text: "Hello",
    color: "#ff0000", anchor: null, geom: { kind: "pin", selector: "#title", x: 0.5, y: 0.5, vw: 1000, vh: 800 },
    visibility: "shared", status: "open", resolved: false, resolvedBy: null, resolvedAt: null, assignee: null, assignedAt: null,
    replies: [], createdAt: now, updatedAt: now, editedAt: null, ...extra,
  };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await sleep(50); }
}
