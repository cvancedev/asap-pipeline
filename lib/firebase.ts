import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDHeBQRIUv4Q544TZeHjqln6dEJ8xFDpL4",
  authDomain: "asap-pipeline.firebaseapp.com",
  projectId: "asap-pipeline",
  storageBucket: "asap-pipeline.firebasestorage.app",
  messagingSenderId: "788575719840",
  appId: "1:788575719840:web:684aea2d4df4bb799414c5",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);