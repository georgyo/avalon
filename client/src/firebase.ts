// Firebase initialization and exports
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from './firebase-config';

// Initialize Firebase app
const app = initializeApp(firebaseConfig);
// Initialize services
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };