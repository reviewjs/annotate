// Bundled by scripts/build-firebase-e2e.mjs for tests/firebase.spec.js.
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInAnonymously } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { firebaseTransport } from "../../firebase.mjs";

const params = new URLSearchParams(location.search);
const REVIEW = params.get("review");
let app, auth, db;

// Step 1: sign in, so the test can promote this user to author (Admin path).
window.__signIn = async () => {
  app = initializeApp({ projectId: "demo-annotate", apiKey: "fake" });
  auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  await signInAnonymously(auth);
  return auth.currentUser.uid;
};
// Step 2: start Annotate on the Firebase transport.
window.__start = () => {
  window.AnnotateConfig = {
    project: "fb", reviewId: REVIEW, page: params.get("page") || "/fb", startOpen: true,
    transport: firebaseTransport({ app, reviewId: REVIEW, firestore: db, auth }),
  };
  const s = document.createElement("script");
  s.src = "/annotate.js";
  document.body.appendChild(s);
};
