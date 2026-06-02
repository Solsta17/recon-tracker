// src/firebase.js
//
// ─────────────────────────────────────────────────────────────────────────────
// STEP: Paste your Firebase project config here.
//
// How to get this:
//   1. Go to https://console.firebase.google.com
//   2. Select your project → Project Settings (gear icon)
//   3. Scroll to "Your apps" → Web app → click the </> icon if no app yet
//   4. Copy the firebaseConfig object and paste the values below
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey:            "PASTE_YOUR_API_KEY_HERE",
  authDomain:        "PASTE_YOUR_AUTH_DOMAIN_HERE",
  projectId:         "PASTE_YOUR_PROJECT_ID_HERE",
  storageBucket:     "PASTE_YOUR_STORAGE_BUCKET_HERE",
  messagingSenderId: "PASTE_YOUR_MESSAGING_SENDER_ID_HERE",
  appId:             "PASTE_YOUR_APP_ID_HERE",
};

const app     = initializeApp(firebaseConfig);
export const db      = getFirestore(app);
export const storage = getStorage(app);
