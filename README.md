# Firefox Workspaces

Edge-like workspaces for Firefox with live cross-device sync via Firebase.

Each workspace opens in its own browser window with a colour-coded toolbar. Tab state is written to Firebase on every change and appears on your other devices within ~1 second.

---

## Features

- **Workspace per window** — colour-coded toolbar icon per workspace
- **Live sync** — tab changes push to Firebase in real time; other open devices apply them immediately via Server-Sent Events
- **Offline queue** — changes made offline are queued and flushed on reconnect; newest timestamp wins (last-write-wins per workspace)
- **Google Sign-In** — sign in once with your Google account; no manual config needed after setup
- **Multi-account** — multiple Google accounts share the same database, automatically separated by Firebase UID

---

## Install

Download the latest `.xpi` from [Releases](../../releases) and install via:

**about:addons → ⚙ → Install Add-on From File**

---

## One-time Firebase + Google Auth setup

This setup takes about 10–15 minutes. You only do it once.

### 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it (e.g. `workspaces`)
2. Left sidebar → **Build → Realtime Database → Create database → Start in locked mode**
3. Copy the database URL (e.g. `https://your-project-rtdb.firebaseio.com`)
4. Left sidebar → **Build → Authentication → Get started → Sign-in method → Google → Enable → Save**

### 2. Get the Firebase Web API Key

1. Firebase Console → ⚙ **Project Settings → General**
2. Under **Your apps**, click **Add app → Web** (name it anything)
3. Copy the **apiKey** value — it looks like `AIzaSy...`

### 3. Create a Google OAuth Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → select the same project
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Under **Authorised redirect URIs**, you need to add the extension's redirect URL.
   - Open the extension popup → ⚙ gear icon — it shows the redirect URL you need to register (it looks like `https://<extension-id>.chromiumapp.org/` or similar)
   - Add that URL and click **Save**
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`)

### 4. Put the credentials into background.js

Open `background.js` and fill in the two constants near the top:

```javascript
const FIREBASE_API_KEY  = 'AIzaSy...';          // from step 2
const GOOGLE_CLIENT_ID  = '123...apps.googleusercontent.com';  // from step 3
```

### 5. Set Firebase database rules

The rules check that the signed-in user's email is in your approved list. Go to Firebase Console → **Realtime Database → Rules** and paste:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read":  "auth != null && auth.uid == $uid",
        ".write": "auth != null && auth.uid == $uid && (
          root.child('approvedEmails').child(auth.token.email.replace('.', ',')).exists()
        )"
      }
    },
    "approvedEmails": {
      ".read":  false,
      ".write": false
    }
  }
}
```

Then add your approved email addresses as keys under `/approvedEmails` (dots in email addresses must be replaced with commas because Firebase keys can't contain dots):

```json
{
  "approvedEmails": {
    "you@gmail,com": true,
    "friend@gmail,com": true
  }
}
```

You can do this in the Firebase Console → **Realtime Database → Data** tab, or via the REST API.

> **Simpler alternative rules** — if you only use the database yourself and aren't worried about other Firebase users reading your data, you can use:
> ```json
> { "rules": { "users": { "$uid": { ".read": "auth.uid == $uid", ".write": "auth.uid == $uid" } } } }
> ```
> This restricts each user to their own path without the email whitelist.

### 6. Sign in

Open the extension popup → ⚙ gear icon → **Sign in with Google**. A browser window will open for Google OAuth. After approving, the sync dot in the popup header will turn green.

---

## Multi-user / account separation

Data is separated by Firebase UID (derived from your Google account). Two different Google accounts using the same database write to completely separate paths and never see each other's data.

**Firebase data structure:**
```
/users/{firebaseUid}/workspaces/{workspaceId}
  → { id, name, color, tabs[], createdAt, lastUsed, updatedAt }
```

---

## Conflict resolution (offline → online)

When a device makes changes while offline:

1. Changes queue in local storage with a wall-clock `updatedAt` timestamp
2. On reconnect, the queued timestamp is compared against what's in Firebase
3. **Newer timestamp wins** — if your offline changes are newer, they overwrite the remote; if the remote is newer (another device changed it while you were offline), the queue is discarded and the remote state is kept

---

## Usage

| Action | How |
|---|---|
| Open a workspace | Click its name in the popup — opens in a new window (or focuses existing) |
| Create from current tabs | Popup → "New from current tabs" |
| Create blank | Popup → "New blank workspace" |
| Rename / Recolor | Hover workspace → `···` menu |
| Delete | Hover workspace → `···` menu → Delete |
| Firebase settings / Sign in | Popup → ⚙ gear icon |
| Export / Import | Popup → Export / Import buttons (JSON) |

---

## File structure

```
workspaces/
├── manifest.json        Extension manifest (MV2, persistent background page)
├── background.js        Core logic: Firebase sync, tab tracking, window management
├── popup/
│   ├── popup.html       Popup markup (main / form / delete / settings views)
│   ├── popup.js         Popup logic
│   └── popup.css        Styling (light + dark mode)
├── icons/
│   └── icon-*.svg
├── update.py            Signs, bumps version, commits, pushes, creates GitHub release
└── .env                 AMO API credentials (not committed)
```

---

## Building / signing

Requires Node.js (`web-ext`) and Python 3. Copy `.env.example` → `.env` and fill in AMO credentials:

```
AMO_API_KEY=user:12345:678
AMO_API_SECRET=your_jwt_secret_here
```

Then run:

```bash
python update.py              # bump patch + sign + commit + push + release
python update.py --no-bump    # sign without changing version
python update.py --no-push    # sign only, no git commit/push
python update.py --no-release # skip GitHub release
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Sync dot is yellow | Firebase offline or connecting — check your internet connection |
| Sync dot is grey | Not signed in — click ⚙ and sign in with Google |
| Sign-in window doesn't open | Check that the redirect URL shown in ⚙ is registered in Google Cloud Console OAuth credentials |
| Tabs not appearing on other device | Confirm both devices show a green sync dot |
| Extension disappears after restart | Use the `.xpi` install method, not temporary load |
| Icon doesn't change colour | Requires Firefox 89+ |
| Write rejected (403) | Your email may not be in the `approvedEmails` list in Firebase |
