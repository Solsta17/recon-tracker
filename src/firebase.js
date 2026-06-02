import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyBQuICHbX3ma-hk4jtfW0Oh030ei8DhsS8",
  authDomain: "iao-inventory.firebaseapp.com",
  projectId: "iao-inventory",
  storageBucket: "iao-inventory.firebasestorage.app",
  messagingSenderId: "836259648028",
  appId: "1:836259648028:web:e510d828319da46c6a05d9",
};

const app     = initializeApp(firebaseConfig);
export const db      = getFirestore(app);
export const storage = getStorage(app);
