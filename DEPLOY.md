# Recon Tracker — Deployment Guide
## Firebase + Netlify + PWA Home Screen Icon

---

## What you need (all free)
- A **Google account** (for Firebase)
- A **GitHub account** (free at github.com) — Netlify deploys from here
- A **Netlify account** (free at netlify.com)

---

## STEP 1 — Set up Firebase (10 min)

### 1a. Create a Firebase project
1. Go to **https://console.firebase.google.com**
2. Click **"Add project"**
3. Name it something like `recon-tracker`
4. Disable Google Analytics (not needed) → **Create project**

### 1b. Enable Firestore database
1. In your project, click **"Firestore Database"** in the left sidebar
2. Click **"Create database"**
3. Choose **"Start in test mode"** → Next
4. Pick any location (closest to you) → **Enable**

### 1c. Enable Firebase Storage (for photos)
1. Click **"Storage"** in the left sidebar
2. Click **"Get started"**
3. Choose **"Start in test mode"** → Next → **Done**

### 1d. Register a web app and get your config
1. Click the **gear icon** (top left) → **Project settings**
2. Scroll down to **"Your apps"** section
3. Click the **`</>`** (web) icon
4. App nickname: `recon-tracker` → click **"Register app"**
5. You'll see a `firebaseConfig` object that looks like this:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "recon-tracker-xxxxx.firebaseapp.com",
  projectId: "recon-tracker-xxxxx",
  storageBucket: "recon-tracker-xxxxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};
```

6. **Copy these values** — you'll paste them into `src/firebase.js` in the next step

---

## STEP 2 — Add your Firebase config to the app

Open the file **`src/firebase.js`** and replace the placeholder values with your real ones:

```js
const firebaseConfig = {
  apiKey:            "PASTE_YOUR_API_KEY_HERE",        // ← replace
  authDomain:        "PASTE_YOUR_AUTH_DOMAIN_HERE",    // ← replace
  projectId:         "PASTE_YOUR_PROJECT_ID_HERE",     // ← replace
  storageBucket:     "PASTE_YOUR_STORAGE_BUCKET_HERE", // ← replace
  messagingSenderId: "PASTE_YOUR_MESSAGING_SENDER_ID_HERE", // ← replace
  appId:             "PASTE_YOUR_APP_ID_HERE",         // ← replace
};
```

Save the file.

---

## STEP 3 — Put the project on GitHub

1. Go to **https://github.com** → sign in → click **"New repository"**
2. Name it `recon-tracker` → **Create repository** (keep it private if you want)
3. Upload your project files:
   - Click **"uploading an existing file"**
   - Drag and drop the entire `recon-tracker` folder contents
   - Or use the GitHub Desktop app if you prefer
4. Click **"Commit changes"**

> **Folder structure should look like:**
> ```
> recon-tracker/
> ├── public/
> │   ├── index.html
> │   ├── manifest.json
> │   ├── icon-192.png
> │   └── icon-512.png
> ├── src/
> │   ├── App.js
> │   ├── firebase.js
> │   └── index.js
> └── package.json
> ```

---

## STEP 4 — Deploy on Netlify (5 min)

1. Go to **https://app.netlify.com** → sign in with GitHub
2. Click **"Add new site"** → **"Import an existing project"**
3. Click **"Deploy with GitHub"** → authorize → select your `recon-tracker` repo
4. Build settings (Netlify usually auto-detects these):
   - **Build command:** `npm run build`
   - **Publish directory:** `build`
5. Click **"Deploy site"**
6. Wait ~2 minutes — Netlify will give you a URL like `https://amazing-name-123456.netlify.app`

That's your live app. Share that URL with your team.

---

## STEP 5 — Add to phone home screen (PWA icon)

### iPhone (Safari)
1. Open the Netlify URL in **Safari** (must be Safari, not Chrome)
2. Tap the **Share button** (box with arrow pointing up)
3. Scroll down → tap **"Add to Home Screen"**
4. Name it **"Recon"** or whatever you want → tap **Add**
5. The 🔧 icon appears on your home screen — tap it to launch full-screen

### Android (Chrome)
1. Open the Netlify URL in **Chrome**
2. Tap the **three-dot menu** (top right)
3. Tap **"Add to Home screen"**
4. Tap **Add**
5. Icon appears on home screen

---

## After deployment

### Changing the admin PIN
Log in with name `Admin` / PIN `1234` → go to **👥 Users** tab → remove the default Admin and add a new one with your own name and PIN.

### Adding team members
Log in as Admin → **👥 Users** → **+ Add User** → set their name, PIN, and role.

### Free tier limits
- **Firestore:** 50,000 reads/day, 20,000 writes/day — more than enough for a shop
- **Storage:** 5 GB for photos — plenty
- **Netlify:** 100 GB bandwidth/month, unlimited deploys

### Updating the app later
If you make changes to the code, just push them to GitHub — Netlify automatically rebuilds and redeploys. Usually takes under 2 minutes.

---

## Firestore security (optional but recommended)

Right now the database is in "test mode" which means anyone with the URL can read/write data. This is fine if you're the only ones using it, but to lock it down:

1. Go to Firebase Console → Firestore → **Rules** tab
2. Replace the rules with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.time < timestamp.date(2026, 1, 1);
    }
  }
}
```

For now that works fine. Proper auth-based rules would require adding Firebase Authentication, which is a future enhancement if needed.
