// FIREBASE


const firebaseConfig = {
    apiKey: "AIzaSyCrdxqndYpNxiI6NdvN4y4JqWBnPBl0Jgg",
    authDomain: "optischedule-4f530.firebaseapp.com",
    projectId: "optischedule-4f530",
    storageBucket: "optischedule-4f530.firebasestorage.app",
    messagingSenderId: "348135854534",
    appId: "1:348135854534:web:971a8016efff366943e2c7"
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// the local cache lets the app keep working offline and sync when you reconnect
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
