# Liyog Push Notification System — Full Team Reference

**System:** liyog-push-notify  
**Owner:** Ejumah Bartholomew O. (Liyog Bartoos O.)  
**Platform:** Liyog World Global — liyogworld.com.ng  
**Stack:** Cloudflare Workers · D1 Database · Cloudflare Queues · Web Push (VAPID) · FCM (dormant)  
**GitHub:** github.com/liyx-dev/liyog-push-notify  
**Worker URL:** https://liyog-push-notify.goddayprincess1.workers.dev  
**Live domain:** https://www.liyogworld.com.ng

---

## Table of Contents

1. How the system works (plain language overview)
2. File-by-file explanation
3. How files connect to each other
4. All API endpoints with examples
5. Subscribing users — web and app
6. Ads — AdSense and AdMob
7. The feed — what it is and how to embed it
8. Database tables, storage, and cleanup
9. VAPID keys — what they are, recovery, rotation
10. Database queries for quick health checks
11. Android app setup (when the app is built)
12. Testing every part of the system
13. Troubleshooting common issues
14. How to scale to other platforms or blogs

---

## 1. How the system works (plain language)

Think of this system as three independent workers doing one job each:

**The Watcher** (cron, runs every 10 minutes)
Polls your Blogger RSS feed. If it finds a post it has never seen before, it saves it to the database and drops a message into the Queue saying "there is a new post, notify everyone."

**The Dispatcher** (queue consumer)
Picks up that queue message, loads the post from the database, builds a rich push payload (title, excerpt, image, URL), then loops through every active subscriber and sends each one a push notification. If a subscription is dead (browser uninstalled, user revoked permission), it deactivates it automatically.

**The Server** (HTTP Worker)
Answers API requests from your blog, admin dashboard, and future app. Handles: saving new subscriptions, serving the /notifications landing page, returning the feed JSON, tracking opens, and authenticated admin actions.

When a notification arrives on a user's phone:
- Android shows it in the notification shade — title, body text, featured image
- User taps it → sw.js (service worker) wakes up → opens the URL stored in the notification
- In "direct" mode that URL is the post's own liyogworld.com.ng URL
- In "landing" mode that URL is www.liyogworld.com.ng/notifications?post_id=XXX

---

## 2. File-by-file explanation

### wrangler.toml
The configuration file Cloudflare reads when deploying. Defines:
- Which D1 database to bind (as `DB`)
- Which queue to bind (as `PUSH_QUEUE`)
- Which static folder to serve (as `ASSETS`, the `/public` folder)
- Environment variables (VAPID_SUBJECT, BLOG_FEED_URL, FEED_PAGE_URL, NOTIFICATION_MODE)
- The cron schedule (every 10 minutes)
Secrets (VAPID keys, ADMIN_API_KEY) are NOT stored here — they live in Cloudflare's encrypted secret store.

### src/index.js
The main Worker file. Contains three exported handlers:
- `fetch` — handles all HTTP requests (API + static file serving)
- `scheduled` — runs on the cron trigger, polls Blogger, queues new posts
- `queue` — processes queue messages, sends pushes to all subscribers

### src/lib/webpush.js
Implements the Web Push encryption spec (RFC 8291 + RFC 8292 VAPID) from scratch using only the browser-standard Web Crypto API. This was necessary because the popular `web-push` npm package requires Node.js crypto which is not available in Cloudflare Workers. This file handles: VAPID JWT signing, ECDH key agreement, AES-128-GCM message encryption.

### src/lib/blogger.js
Fetches your Blogger JSON feed, extracts new posts, and returns them. Handles: featured image extraction (upgrades thumbnail size to s1200), clean excerpt extraction (strips HTML tags, decodes entities, breaks at sentence boundary), URL extraction with fallback.

### src/lib/feed.js
Builds the "smart feed" — fetches the latest N posts from the database and optionally swaps the last slot with a genuinely popular post from the last 14 days (one with popularity_score > 0). This is the same logic Facebook/news apps use to mix fresh and engaging content.

### src/lib/fcm.js
Sends push notifications to Android devices via Firebase Cloud Messaging HTTP v1 API. Currently dormant — it checks for FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT secrets at runtime, and if they are not set, it logs a message and returns without sending. When your Android app ships, you set those two secrets and it activates with zero code changes.

### public/sw.js
The service worker. Runs inside the user's browser (not on the server). Listens for two events:
- `push` — receives the encrypted push message from Chrome's push service, decrypts it, shows the OS notification
- `notificationclick` — fires when user taps the notification, opens the correct URL, fires tracking pixel
Must be served from the real domain (www.liyogworld.com.ng/sw.js) because browsers only allow a service worker to control pages on the same domain it was served from.

### public/subscribe-client.js
Runs on your blog. Checks if the user has already subscribed (by checking the browser's PushManager directly — same method OneSignal uses). If not subscribed and not snoozed, shows a slide-up prompt after 3 seconds. Handles the full subscribe flow: permission request → service worker registration → VAPID subscribe → save to server. "Later" snoozes for 24 hours. Once subscribed, never shows again in that browser.

### public/notifications.html
The premium landing page served at www.liyogworld.com.ng/notifications. Used in "landing" mode. Shows a hero card (the tapped post, highlighted) and a horizontal scroll rail of the next 4 posts. All cards link directly to their correct post URLs. Has a "Visit Liyog World Global" button. Also works as a standalone "What's New" page users can bookmark.

### public/admin.html
The admin dashboard at www.liyogworld.com.ng/admin. Password-protected by ADMIN_API_KEY. Contains: system health overview, stats, compose panel (with Quill rich editor and live preview), posts table, subscribers table, notification logs, test push button.

### schema.sql
The D1 database schema. Run once to create tables. Safe to run again (uses IF NOT EXISTS). Contains four tables: push_subscriptions, device_tokens, posts_cache, notification_log.

### scripts/generate-vapid-keys.mjs
A local Node.js script to generate a new VAPID key pair. Only run this locally — never in production. Output is two values you paste as Cloudflare secrets.

---

## 3. How files connect to each other

```
Blogger RSS feed
      ↓ (every 10 min)
blogger.js → fetches new posts
      ↓
index.js (scheduled) → saves to D1 posts_cache → sends to PUSH_QUEUE
      ↓
index.js (queue consumer) → loads post from D1
      ↓
webpush.js → encrypts + sends to each endpoint in push_subscriptions
fcm.js     → sends to each token in device_tokens (dormant)
      ↓
notification_log ← records success/failure
      ↓
User's phone: sw.js receives push → shows OS notification
      ↓
User taps → sw.js opens URL → tracking pixel → popularity_score++

Blog page:
subscribe-client.js → user taps Subscribe → sw.js registered
→ pushManager.subscribe() → saves endpoint to push_subscriptions via /api/push/subscribe

Admin:
admin.html → calls /api/admin/* endpoints in index.js
→ reads D1 directly for stats, logs, posts, subscribers
→ calls /api/admin/custom-push → webpush.js fan-out

feed.js → called by /api/feed → reads posts_cache → returns smart-mixed list
→ used by notifications.html (landing page) + any future embed
```

---

## 4. All API endpoints

Base URL: `https://liyog-push-notify.goddayprincess1.workers.dev`

All POST requests need header: `Content-Type: application/json`  
Admin endpoints need header: `X-Admin-Key: YOUR_ADMIN_API_KEY`

---

### Public endpoints (no auth needed)

#### GET /api/push/vapid-public-key
Returns the VAPID public key needed by the browser before subscribing.
```
GET /api/push/vapid-public-key
Response: { "publicKey": "BD9o03sF..." }
```

#### POST /api/push/subscribe
Saves a browser's Web Push subscription to the database.
```
POST /api/push/subscribe
Body: {
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": {
    "p256dh": "BGgtaV...",
    "auth": "abc123..."
  },
  "subscriberId": "optional-user-id"
}
Response: { "ok": true }
```
Note: `subscriberId` is optional. Use it when you have a logged-in user ID you want to link to the subscription for later personalisation.

#### POST /api/push/unsubscribe
Deactivates a subscription (does not delete, just marks inactive).
```
POST /api/push/unsubscribe
Body: { "endpoint": "https://fcm.googleapis.com/fcm/send/..." }
Response: { "ok": true }
```
Note: the endpoint comes from `subscription.endpoint` in the browser after calling `pushManager.getSubscription()`.

#### POST /api/device/register
Saves an Android FCM token (used when app is built).
```
POST /api/device/register
Body: {
  "token": "FCM_DEVICE_TOKEN_HERE",
  "platform": "android",
  "subscriberId": "optional-user-id"
}
Response: { "ok": true }
```

#### GET /api/feed
Returns the smart-mixed post feed. Used by the landing page and any embed.
```
GET /api/feed?platform=web&limit=5
GET /api/feed?platform=app&limit=5

Response: {
  "platform": "web",
  "ads": { "network": "adsense" },
  "items": [
    {
      "post_id": "123456",
      "title": "Beyond Biology",
      "url": "https://www.liyogworld.com.ng/...",
      "featured_image": "https://blogger.googleusercontent.com/...",
      "excerpt": "The greatest inheritance...",
      "category": "Faith",
      "published_at": "2026-06-21T08:28:50.810-07:00"
    }
  ]
}
```
- `platform=web` → ads.network returns "adsense"
- `platform=app` → ads.network returns "admob"
- `limit` can be 1–10

#### GET /api/track/open
Records that a user opened a notification. Called automatically by sw.js.
```
GET /api/track/open?post_id=123456&ref=https%3A%2F%2Ffcm...
Response: { "ok": true }
```

---

### Admin endpoints (require X-Admin-Key header)

#### GET /api/admin/stats
Returns full system health data for the dashboard.
```
GET /api/admin/stats
Headers: X-Admin-Key: your-key
Response: {
  "mode": "direct",
  "subscribers": { "total": 42, "active": 38 },
  "devices": { "total": 0, "active": 0 },
  "posts": { "total": 15, "notified": 13 },
  "logSummary": [{"status":"sent","cnt":120}, {"status":"failed","cnt":3}],
  "recentLogs": [...]
}
```

#### GET /api/admin/posts
Returns all cached posts (last 100).
```
GET /api/admin/posts
Headers: X-Admin-Key: your-key
```

#### GET /api/admin/subscribers
Returns all web push subscribers (last 200, endpoint truncated for safety).
```
GET /api/admin/subscribers
Headers: X-Admin-Key: your-key
```

#### POST /api/admin/custom-push
Sends a fully custom push notification to all active web subscribers.
```
POST /api/admin/custom-push
Headers: X-Admin-Key: your-key
Body: {
  "title": "Special Announcement",
  "body": "We have something important to share with you.",
  "image": "https://...",
  "actionUrl": "https://www.liyogworld.com.ng/special-page"
}
Response: { "ok": true, "sent": 38, "failed": 0 }
```

#### POST /internal/posts/new
Manually inserts a post and queues a push. Use for posts not on Blogger, or to resend.
```
POST /internal/posts/new
Headers: X-Admin-Key: your-key
Body: {
  "postId": "unique-id",
  "title": "Post Title",
  "url": "https://www.liyogworld.com.ng/post-url",
  "featuredImage": "https://...",
  "excerpt": "Short description",
  "category": "Faith",
  "publishedAt": "2026-07-01T10:00:00Z"
}
Response: { "ok": true, "queued": true }
```

#### POST /api/admin/poll-now
Forces an immediate Blogger feed poll without waiting for the cron.
```
POST /api/admin/poll-now
Headers: X-Admin-Key: your-key
Response: { "ok": true, "newPostsFound": 2 }
```

---

### Static pages (served as HTML)

| URL | What it shows |
|-----|--------------|
| www.liyogworld.com.ng/notifications | Premium landing page (latest posts) |
| www.liyogworld.com.ng/admin | Admin dashboard |
| www.liyogworld.com.ng/sw.js | Service worker script |
| www.liyogworld.com.ng/subscribe-client.js | Blog subscribe script |

---

## 5. Subscribing users — web and app

### Web (Blogger blog) — already live
Add this single line before `</body>` in your Blogger template:
```html
<script src="https://www.liyogworld.com.ng/subscribe-client.js"></script>
```
That is all. The script handles everything: prompt display, permission request, service worker registration, saving to database. No HTML elements needed.

### Web (any other website you own)
Same script tag. The `subscribe-client.js` checks `Notification.permission` and `pushManager` which are browser APIs — they work on any HTTPS website. The subscription is saved to your same D1 database.

### Web (collecting subscribers for a different platform/blog)
Call the subscribe API directly with a `subscriberId` to tag which platform they came from:
```js
// After getting a PushSubscription object from the browser
await fetch("https://liyog-push-notify.goddayprincess1.workers.dev/api/push/subscribe", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ...subscription.toJSON(),
    subscriberId: "biziplex-user-001"  // tag them with their origin
  })
});
```
Later when sending, you can query `push_subscriptions WHERE subscriber_id LIKE 'biziplex-%'` to target only those users.

### Android app — when it is built
Step 1: Add Firebase to your Android project in Android Studio.  
Step 2: Get your `google-services.json` from the Firebase console, place it in the app module.  
Step 3: Create a Firebase service account JSON key (Firebase Console → Project Settings → Service Accounts → Generate New Private Key).  
Step 4: Set two Cloudflare secrets:
```
wrangler secret put FCM_PROJECT_ID
# paste your Firebase project ID (e.g. liyog-world-app)

wrangler secret put FCM_SERVICE_ACCOUNT
# paste the entire content of your service account JSON key file
```
Step 5: In your Android app, on launch, call:
```kotlin
FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
  val token = task.result
  // Send to your Worker
  val url = "https://liyog-push-notify.goddayprincess1.workers.dev/api/device/register"
  // POST { "token": token, "platform": "android", "subscriberId": userId }
}
```
Step 6: That is it. The Worker's queue consumer already fans out to FCM tokens — `fcm.js` activates automatically once the secrets exist.

For displaying the notification feed inside the app, call:
```
GET /api/feed?platform=app&limit=5
```
The response includes `"ads": { "network": "admob" }` — render an AdMob banner in your app's UI next to the feed cards.

---

## 6. Ads — AdSense and AdMob

The system does not insert ad code automatically — it tells your frontend which ad network to use, and your frontend renders the ad. This keeps the Worker clean and lets you control ad placement yourself.

### How it works
Every call to `/api/feed` returns:
```json
"ads": { "network": "adsense" }   // when platform=web
"ads": { "network": "admob" }     // when platform=app
```

### Web (AdSense)
In `notifications.html` or any page that calls `/api/feed`, after rendering the cards:
```js
if (ads.network === "adsense") {
  // Insert your AdSense unit
  const adDiv = document.createElement("div");
  adDiv.innerHTML = `<ins class="adsbygoogle" style="display:block"
    data-ad-client="ca-pub-XXXXXXXXXXXXXXXX"
    data-ad-slot="XXXXXXXXXX"
    data-ad-format="auto"></ins>`;
  feedContainer.appendChild(adDiv);
  (adsbygoogle = window.adsbygoogle || []).push({});
}
```
Make sure your AdSense `<script>` tag is in the `<head>` of the page.

### App (AdMob)
In your Android app, after rendering the feed cards from `/api/feed?platform=app`:
```kotlin
if (feedResponse.ads.network == "admob") {
  // Load an AdMob banner or interstitial
  val adRequest = AdRequest.Builder().build()
  adView.loadAd(adRequest)
  adView.visibility = View.VISIBLE
}
```

---

## 7. The feed — embedding it anywhere

The feed endpoint returns clean JSON you can render anywhere.

### Embed as a "Latest Posts" widget on any page
```html
<div id="liyog-latest"></div>
<script>
fetch("https://liyog-push-notify.goddayprincess1.workers.dev/api/feed?platform=web&limit=4")
  .then(r => r.json())
  .then(({ items }) => {
    document.getElementById("liyog-latest").innerHTML = items.map(post => `
      <a href="${post.url}" style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #eee;text-decoration:none;color:inherit">
        <img src="${post.featured_image || ''}" width="80" height="60"
             style="object-fit:cover;border-radius:6px;flex-shrink:0" onerror="this.style.display='none'"/>
        <div>
          <div style="font-weight:700;font-size:14px;line-height:1.3">${post.title}</div>
          <div style="font-size:12px;color:#777;margin-top:4px">${post.excerpt || ''}</div>
        </div>
      </a>`).join("");
  });
</script>
```

### Use the /notifications page as a standalone "What's New" screen
Link to it from anywhere:
```html
<a href="https://www.liyogworld.com.ng/notifications">See what's new →</a>
```
With a specific post highlighted:
```html
<a href="https://www.liyogworld.com.ng/notifications?post_id=POST_ID_HERE">See this post →</a>
```

---

## 8. Database tables, storage, and cleanup

### push_subscriptions
Stores browser push subscriptions. Rows are never deleted automatically — they are just marked `active = 0` when a subscription dies (browser uninstall, permission revoked). You should periodically delete old inactive rows.

Cleanup query (run manually in D1 console, e.g. monthly):
```sql
DELETE FROM push_subscriptions
WHERE active = 0
AND last_seen_at < datetime('now', '-90 days');
```

### device_tokens
Same structure as push_subscriptions but for Android FCM tokens. Same cleanup applies.

### posts_cache
Stores every blog post the cron has ever seen. Grows indefinitely. You don't need posts older than a few months. Recommended: keep 6 months.
```sql
DELETE FROM posts_cache
WHERE published_at < datetime('now', '-180 days');
```
Important: deleting a post from posts_cache does NOT delete its notification_log entries. The log has the post_id as a text field, not a foreign key, so it is safe.

### notification_log
Records every push delivery attempt. This will be your largest table over time. Keep 90 days:
```sql
DELETE FROM notification_log
WHERE created_at < datetime('now', '-90 days');
```

### Admin compose pushes
Custom pushes sent via `/api/admin/custom-push` are NOT stored in posts_cache — they go directly to webpush.js. They ARE logged in notification_log with a `custom-TIMESTAMP` post_id. They don't accumulate in posts_cache.

### How long does data stay?
Nothing is deleted automatically — the system keeps everything until you run a cleanup query. For a blog with 100 posts/month and 1000 subscribers, the notification_log grows by ~100,000 rows/month. D1 free tier allows 500MB. Run cleanup quarterly.

---

## 9. VAPID keys — what they are, loss, and rotation

### What they are
VAPID (Voluntary Application Server Identification) is a standard that lets push services (Google FCM, Mozilla, etc.) verify that push messages actually come from your server and not an impersonator. They are an ECDSA P-256 key pair:
- **Public key** — shared openly. Your blog's JavaScript uses it to register subscriptions. Push services use it to verify your messages.
- **Private key** — secret. Your Worker uses it to sign each push message. Never share this.

### Your current keys (generated earlier in this session)
```
VAPID_PUBLIC_KEY:
BD9o03sFU5FP_7uH8ANCFMic-sFpaM7SqEt3B6zj5JTyboPxnB4Jg9FODZhIscneYJgaM_of4tBjfB0X0U7uXPI

VAPID_PRIVATE_KEY (full JSON):
{"key_ops":["sign"],"ext":true,"kty":"EC","x":"P2jTewVTkU__u4fwA0IUyJz6wWloztKoS3cHrOPklPI","y":"boPxnB4Jg9FODZhIscneYJgaM_of4tBjfB0X0U7uXPI","crv":"P-256","d":"k-2zNL_jI0XeoUuAg0Eju5rG5jfdrt52m7Xd4P7NKjc"}
```
Store these in a secure password manager (Bitwarden, 1Password, etc.) right now if you haven't already.

### If you lose only the private key
You must generate a new key pair. All existing subscriptions will stop working — browsers will reject push messages signed with a different private key. You will need to re-collect all subscribers.

### If you lose only the public key
No problem — you can derive it from the private key JWK. The `x` and `y` fields in the JWK are the public key coordinates. Run `scripts/generate-vapid-keys.mjs` — it will generate a new pair, but you can also reconstruct by running:
```js
// In Node.js
const jwk = JSON.parse(YOUR_PRIVATE_KEY_JWK);
// x and y are base64url encoded. The raw public key is 0x04 + decode(x) + decode(y)
```
Or simply store both keys in your password manager so this is never an issue.

### If you lose both keys
Generate a completely new pair:
```bash
node scripts/generate-vapid-keys.mjs
```
Then:
```bash
wrangler secret put VAPID_PUBLIC_KEY   # paste new public key
wrangler secret put VAPID_PRIVATE_KEY  # paste new private key JSON
```
Update `subscribe-client.js` — it fetches the public key from `/api/push/vapid-public-key` dynamically, so no code change needed there.
All existing subscribers will get delivery failures on the next push. They will need to re-subscribe. The subscribe prompt will automatically re-appear on their next visit since their old subscription becomes invalid.

### Can you write your own VAPID keys?
No. They must be a valid ECDSA P-256 key pair in the correct format. Always use `scripts/generate-vapid-keys.mjs` to generate them. Do not attempt to type them manually.

### Rotating keys without losing all subscribers (safest method)
There is no zero-downtime key rotation in Web Push. The cleanest approach:
1. Generate new keys
2. Deploy new public key
3. The subscribe prompt will show again on users' next visits (old subscription is invalid)
4. Over 2–4 weeks subscribers naturally re-subscribe as they visit
5. Remove old key after 30 days

---

## 10. Database queries for quick health checks

Run these in your D1 database Console tab on the Cloudflare dashboard.

### How many active subscribers do I have?
```sql
SELECT COUNT(*) as total, SUM(active) as active, SUM(1-active) as inactive
FROM push_subscriptions;
```

### Which browser/device types are subscribed?
```sql
SELECT
  CASE
    WHEN user_agent LIKE '%Chrome%' THEN 'Chrome'
    WHEN user_agent LIKE '%Firefox%' THEN 'Firefox'
    WHEN user_agent LIKE '%Safari%' THEN 'Safari'
    ELSE 'Other'
  END as browser,
  COUNT(*) as count
FROM push_subscriptions
WHERE active = 1
GROUP BY browser;
```

### What posts have been sent and how many opens?
```sql
SELECT post_id, title, notified, popularity_score, published_at
FROM posts_cache
ORDER BY published_at DESC
LIMIT 20;
```

### How many notifications sent this week?
```sql
SELECT COUNT(*) as sent_this_week
FROM notification_log
WHERE status = 'sent'
AND created_at >= datetime('now', '-7 days');
```

### Are there failing subscriptions I should clean up?
```sql
SELECT COUNT(*) as dead_subscriptions
FROM push_subscriptions
WHERE active = 0;
```

### What are the most recent errors?
```sql
SELECT post_id, recipient_type, error, sent_at
FROM notification_log
WHERE status = 'failed'
ORDER BY id DESC
LIMIT 20;
```

### Which posts got the most opens (clicks)?
```sql
SELECT post_id, title, popularity_score
FROM posts_cache
WHERE popularity_score > 0
ORDER BY popularity_score DESC
LIMIT 10;
```

### Full delivery report for the last post sent?
```sql
SELECT status, COUNT(*) as count
FROM notification_log
WHERE post_id = (SELECT post_id FROM posts_cache ORDER BY id DESC LIMIT 1)
GROUP BY status;
```

---

## 11. Android app setup (when the app is built)

Full steps when your Android app is ready:

1. Create a Firebase project at console.firebase.google.com
2. Add an Android app to the project (use your app's package name)
3. Download `google-services.json`, place in `app/` folder
4. Add Firebase Messaging dependency to `build.gradle`
5. Create a Firebase service account key (Project Settings → Service Accounts → Generate New Private Key). Save the JSON file.
6. Set secrets on Cloudflare:
   ```
   wrangler secret put FCM_PROJECT_ID
   # Value: your Firebase project ID string

   wrangler secret put FCM_SERVICE_ACCOUNT
   # Value: paste the entire content of the service account JSON file
   ```
7. In your Android app, register the FCM token on launch:
   ```kotlin
   FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
     lifecycleScope.launch {
       // Call your Worker to register the token
       val client = OkHttpClient()
       val body = """{"token":"$token","platform":"android"}""".toRequestBody("application/json".toMediaType())
       val request = Request.Builder()
         .url("https://liyog-push-notify.goddayprincess1.workers.dev/api/device/register")
         .post(body)
         .build()
       client.newCall(request).execute()
     }
   }
   ```
8. Handle the notification click in your Android app to open the correct post URL (available in the notification's data payload as `url`).
9. For the feed screen in the app: call `/api/feed?platform=app&limit=5`, parse the JSON, render cards natively. Render an AdMob banner alongside since `ads.network` will be `"admob"`.

---

## 12. Testing every part of the system

### Test 1: Worker is alive
Open in browser:
```
https://liyog-push-notify.goddayprincess1.workers.dev/api/push/vapid-public-key
```
Expected: `{"publicKey":"BD9o03sF..."}`

### Test 2: Feed is working
```
https://liyog-push-notify.goddayprincess1.workers.dev/api/feed?platform=web&limit=4
```
Expected: JSON with `items` array containing your blog posts.

### Test 3: Database is connected
```
https://liyog-push-notify.goddayprincess1.workers.dev/api/admin/stats
Header: X-Admin-Key: your-key
```
Expected: stats object with subscriber and post counts.

### Test 4: Subscription flow works
Visit www.liyogworld.com.ng in Chrome on Android. Wait 3 seconds. Tap Subscribe. Check D1 console:
```sql
SELECT * FROM push_subscriptions ORDER BY id DESC LIMIT 1;
```
Expected: a new row with your browser's endpoint.

### Test 5: Push delivery works (test notification)
From admin dashboard → Overview → "Send Test Push" button.
Or via API:
```
POST /internal/posts/new
Headers: X-Admin-Key: your-key
Body: {"postId":"test-NOW","title":"Test","url":"https://www.liyogworld.com.ng/","excerpt":"Testing.","publishedAt":"2026-07-01T10:00:00Z"}
```
Expected: notification appears on your phone within 10 seconds.

### Test 6: Blogger cron poll works
```
POST /api/admin/poll-now
Headers: X-Admin-Key: your-key
```
Expected: `{"ok":true,"newPostsFound":N}` — check D1 posts_cache for new rows.

### Test 7: Landing page works
Open: `https://www.liyogworld.com.ng/notifications`
Expected: dark premium page with your posts, hero card, scroll rail.

### Test 8: Admin dashboard works
Open: `https://www.liyogworld.com.ng/admin`
Expected: login screen → enter ADMIN_API_KEY → dashboard loads with real data.

### Test 9: Open tracking works (after fixing sw.js absolute URL)
After tapping a real notification, run:
```sql
SELECT * FROM notification_log WHERE status = 'opened' ORDER BY id DESC LIMIT 5;
```
Expected: rows with `opened_at` timestamps.

---

## 13. Troubleshooting common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Notification tap opens broken URL | FEED_PAGE_URL without www in wrangler.toml | Change to https://www.liyogworld.com.ng/notifications |
| No notifications being sent | No active subscribers | Check push_subscriptions table |
| Subscriber count 0 in admin | D1 not connected / wrong database_id | Verify database_id in wrangler.toml |
| "Not found" on API calls | Route not matching / trailing slash | Remove trailing slash from URL |
| sw.js fails to register | Served from wrong domain | Confirm Cloudflare route www.liyogworld.com.ng/sw.js exists |
| Deploy fails with Queue error | Queue not created yet | Cloudflare → Queues → Create liyog-push-queue |
| Deploy fails with D1 error | Wrong database_id | Check wrangler.toml database_id |
| Opens column always 0 | Tracking URL is relative | Make tracking fetch URL absolute in sw.js |
| Feed returns empty items array | posts_cache is empty | Run POST /api/admin/poll-now |
| Notification image missing | Post has no featured image | Fallback logo URL is set in queue consumer |

---

## 14. How to scale to other platforms

### Add BiziPlex push notifications
The same Worker can serve BiziPlex subscribers. Tag them with subscriberId:
```js
// In BiziPlex subscribe flow
subscriberId: "biziplex-" + userId
```
To send only to BiziPlex subscribers, add a custom endpoint or use `/api/admin/custom-push` with a different targeting query. The schema already supports this — just filter by `subscriber_id LIKE 'biziplex-%'`.

### Add a social feed notification
When someone gets a new comment or message in the future social feed:
1. Your social feed backend calls `/internal/posts/new` with the notification details
2. Set `url` to the social feed item's URL
3. The same push infrastructure delivers it

### Add a storefront notification (new product, sale, etc.)
Same approach — call `/internal/posts/new` with storefront context. Tag the post_id with a prefix like `store-` to distinguish in logs.

### Serving a second blog
Add a second cron-like Worker (or a second scheduled event) that polls a different RSS feed and calls `/internal/posts/new` for each new post, tagging `subscriberId` with the blog's identifier.

### Moving to a custom domain for the Worker
Instead of `liyog-push-notify.goddayprincess1.workers.dev`, you can add a custom domain in Cloudflare: Worker → Settings → Domains & Routes → Add Custom Domain. This is purely cosmetic for the API. The `www.liyogworld.com.ng/sw.js` route stays as-is regardless.
