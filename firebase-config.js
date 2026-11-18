// ─────────────────────────────────────────────────────────────
//  FIREBASE CONFIG — paste your project's config here.
//  1. Go to https://console.firebase.google.com
//  2. Create a project (or use an existing one)
//  3. Build → Realtime Database → Create Database (start in locked mode)
//  4. Build → Authentication → Sign-in method → enable Anonymous
//  5. Project settings → "Your apps" → Web app → copy firebaseConfig
//     (make sure databaseURL is included)
//  6. Deploy the rules from database.rules.json
// ─────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
  useEmulators: false,
};

// True while the config still contains placeholders.
export const isPlaceholderConfig = Object.values(firebaseConfig).some((v) =>
  String(v).includes("YOUR_"),
);
