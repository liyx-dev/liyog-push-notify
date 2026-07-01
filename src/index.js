import { sendWebPush } from "./lib/webpush.js";
import { sendFcmPush } from "./lib/fcm.js";
import { buildSmartFeed } from "./lib/feed.js";
import { fetchNewBloggerPosts } from "./lib/blogger.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function queueNotifyForPost(env, postId) {
  await env.PUSH_QUEUE.send({ postId });
}

// NOTIFICATION_MODE controls what happens when a notification is tapped:
//   "direct"  → opens the post URL directly on liyogworld.com.ng (original flow)
//   "landing" → opens /notifications?post_id=XXX (premium landing page)
// Change NOTIFICATION_MODE in wrangler.toml [vars] to switch — no code change needed.
function resolveNotifUrl(env, postUrl, postId) {
  const mode = (env.NOTIFICATION_MODE || "direct").trim().toLowerCase();
  if (mode === "landing") {
    return `${env.FEED_PAGE_URL}?post_id=${encodeURIComponent(postId)}`;
  }
  return postUrl || "https://www.liyogworld.com.ng/";
}

const STATIC_PATHS = [
  "/sw.js",
  "/subscribe-client.js",
  "/notifications",
  "/notifications.html",
  "/admin",
  "/admin.html",
];

export default {
  // ── HTTP handler ─────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    // Serve static assets
    if (STATIC_PATHS.includes(pathname)) {
      let assetPath = pathname;
      if (pathname === "/notifications") assetPath = "/notifications.html";
      if (pathname === "/admin")         assetPath = "/admin.html";
      const assetRequest = new Request(
        new URL(assetPath, request.url).toString(),
        request
      );
      const assetResponse = await env.ASSETS.fetch(assetRequest);
      if (assetResponse.status !== 404) return assetResponse;
    }

    try {
      // ── GET /api/push/vapid-public-key ──────────────────────────────
      if (pathname === "/api/push/vapid-public-key" && request.method === "GET") {
        return json({ publicKey: env.VAPID_PUBLIC_KEY });
      }

      // ── POST /api/push/subscribe ────────────────────────────────────
      if (pathname === "/api/push/subscribe" && request.method === "POST") {
        const body = await request.json();
        const { endpoint, keys, subscriberId } = body;
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
          return json({ error: "Invalid subscription payload" }, 400);
        }
        await env.DB.prepare(
          `INSERT INTO push_subscriptions (subscriber_id, endpoint, p256dh, auth, user_agent)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             active = 1, last_seen_at = datetime('now'),
             subscriber_id = excluded.subscriber_id`
        ).bind(
          subscriberId || null, endpoint, keys.p256dh, keys.auth,
          request.headers.get("User-Agent") || ""
        ).run();
        return json({ ok: true });
      }

      // ── POST /api/push/unsubscribe ──────────────────────────────────
      if (pathname === "/api/push/unsubscribe" && request.method === "POST") {
        const { endpoint } = await request.json();
        await env.DB.prepare(
          `UPDATE push_subscriptions SET active = 0 WHERE endpoint = ?`
        ).bind(endpoint).run();
        return json({ ok: true });
      }

      // ── POST /api/device/register ───────────────────────────────────
      if (pathname === "/api/device/register" && request.method === "POST") {
        const { token, platform, subscriberId } = await request.json();
        if (!token) return json({ error: "Missing token" }, 400);
        await env.DB.prepare(
          `INSERT INTO device_tokens (subscriber_id, fcm_token, platform)
           VALUES (?, ?, ?)
           ON CONFLICT(fcm_token) DO UPDATE SET
             active = 1, last_seen_at = datetime('now'),
             subscriber_id = excluded.subscriber_id`
        ).bind(subscriberId || null, token, platform || "android").run();
        return json({ ok: true });
      }

      // ── GET /api/feed ───────────────────────────────────────────────
      if (pathname === "/api/feed" && request.method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit") || 5), 10);
        const platform = url.searchParams.get("platform") === "app" ? "app" : "web";
        const items = await buildSmartFeed(env.DB, limit);
        return json({
          platform,
          ads: platform === "app" ? { network: "admob" } : { network: "adsense" },
          items,
        });
      }

      // ── GET /api/track/open ─────────────────────────────────────────
      if (pathname === "/api/track/open" && request.method === "GET") {
        const postId = url.searchParams.get("post_id");
        const ref    = url.searchParams.get("ref");
        if (postId && ref) {
          await env.DB.prepare(
            `UPDATE notification_log SET status='opened', opened_at=datetime('now')
             WHERE post_id=? AND recipient_ref=?`
          ).bind(postId, ref).run();
          await env.DB.prepare(
            `UPDATE posts_cache SET popularity_score = popularity_score + 1 WHERE post_id=?`
          ).bind(postId).run();
        }
        return json({ ok: true });
      }

      // ── GET /api/admin/stats (admin dashboard data) ─────────────────
      if (pathname === "/api/admin/stats" && request.method === "GET") {
        if (request.headers.get("X-Admin-Key") !== env.ADMIN_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        const [subs, devices, posts, logs, recentLogs] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) as total, SUM(active) as active FROM push_subscriptions`).first(),
          env.DB.prepare(`SELECT COUNT(*) as total, SUM(active) as active FROM device_tokens`).first(),
          env.DB.prepare(`SELECT COUNT(*) as total, SUM(notified) as notified FROM posts_cache`).first(),
          env.DB.prepare(`SELECT status, COUNT(*) as cnt FROM notification_log GROUP BY status`).all(),
          env.DB.prepare(
            `SELECT nl.post_id, nl.recipient_type, nl.status, nl.sent_at, nl.error,
                    pc.title
             FROM notification_log nl
             LEFT JOIN posts_cache pc ON pc.post_id = nl.post_id
             ORDER BY nl.id DESC LIMIT 50`
          ).all(),
        ]);
        const mode = env.NOTIFICATION_MODE || "direct";
        return json({
          mode,
          subscribers: subs,
          devices,
          posts,
          logSummary: logs.results || [],
          recentLogs: recentLogs.results || [],
        });
      }

      // ── GET /api/admin/posts ────────────────────────────────────────
      if (pathname === "/api/admin/posts" && request.method === "GET") {
        if (request.headers.get("X-Admin-Key") !== env.ADMIN_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        const posts = await env.DB.prepare(
          `SELECT post_id, title, url, featured_image, excerpt, category,
                  published_at, notified, popularity_score
           FROM posts_cache ORDER BY published_at DESC LIMIT 100`
        ).all();
        return json({ posts: posts.results || [] });
      }

      // ── GET /api/admin/subscribers ──────────────────────────────────
      if (pathname === "/api/admin/subscribers" && request.method === "GET") {
        if (request.headers.get("X-Admin-Key") !== env.ADMIN_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        const subs = await env.DB.prepare(
          `SELECT id, subscriber_id, user_agent, active, created_at, last_seen_at,
                  substr(endpoint,1,60) as endpoint_preview
           FROM push_subscriptions ORDER BY id DESC LIMIT 200`
        ).all();
        return json({ subscribers: subs.results || [] });
      }

      // ── POST /api/admin/custom-push (send a custom notification) ────
      if (pathname === "/api/admin/custom-push" && request.method === "POST") {
        if (request.headers.get("X-Admin-Key") !== env.ADMIN_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        const { title, body, image, actionUrl, postId } = await request.json();
        if (!title || !body) return json({ error: "title and body are required" }, 400);

        const fallbackUrl = "https://www.liyogworld.com.ng/";
        const targetUrl = actionUrl
          ? actionUrl
          : postId
            ? resolveNotifUrl(env, fallbackUrl, postId)
            : fallbackUrl;

        const payload = {
          title,
          body,
          image:  image  || null,
          icon:   "https://www.liyogworld.com.ng/favicon.ico",
          badge:  "https://www.liyogworld.com.ng/favicon.ico",
          url:    targetUrl,
          postId: postId || `custom-${Date.now()}`,
        };

        const { results: webSubs } = await env.DB.prepare(
          `SELECT * FROM push_subscriptions WHERE active = 1`
        ).all();

        let sent = 0, failed = 0;
        for (const sub of webSubs || []) {
          try {
            const result = await sendWebPush({ subscription: sub, payload, env });
            if (result.ok) sent++; else failed++;
            if (result.status === 404 || result.status === 410) {
              await env.DB.prepare(
                `UPDATE push_subscriptions SET active = 0 WHERE endpoint = ?`
              ).bind(sub.endpoint).run();
            }
          } catch (e) { failed++; }
        }
        return json({ ok: true, sent, failed });
      }

      // ── POST /internal/posts/new ────────────────────────────────────
      if (pathname === "/internal/posts/new" && request.method === "POST") {
        if (request.headers.get("X-Admin-Key") !== env.ADMIN_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        const post = await request.json();
        if (!post.postId || !post.title || !post.url) {
          return json({ error: "postId, title and url are required" }, 400);
        }
        await env.DB.prepare(
          `INSERT INTO posts_cache
             (post_id, title, url, featured_image, excerpt, category, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(post_id) DO UPDATE SET
             title=excluded.title, url=excluded.url,
             featured_image=excluded.featured_image,
             excerpt=excluded.excerpt, category=excluded.category`
        ).bind(
          post.postId, post.title, post.url,
          post.featuredImage || null, post.excerpt || null,
          post.category || null,
          post.publishedAt || new Date().toISOString()
        ).run();
        await queueNotifyForPost(env, post.postId);
        return json({ ok: true, queued: true });
      }

      return json({ error: "Not found" }, 404);

    } catch (err) {
      console.error("[fetch error]", err);
      return json({ error: "Internal server error", message: err.message }, 500);
    }
  },

  // ── Cron ─────────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const newPosts = await fetchNewBloggerPosts(env.DB, env.BLOG_FEED_URL);
        for (const post of newPosts) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO posts_cache
               (post_id, title, url, featured_image, excerpt, category, published_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            post.postId, post.title, post.url,
            post.featuredImage, post.excerpt, post.category, post.publishedAt
          ).run();
          await queueNotifyForPost(env, post.postId);
          console.log("[cron] queued:", post.postId, post.title);
        }
      } catch (err) {
        console.error("[cron error]", err);
      }
    })());
  },

  // ── Queue consumer ────────────────────────────────────────────────────
  async queue(batch, env, ctx) {
    const FALLBACK_IMAGE = "https://blogger.googleusercontent.com/img/a/AVvXsEhU2MxWUfqe3_mL2XlAzymc4I4AT97rIsEO8Cxk288oU2p8leSdh2wXOdZHR3YgOkjVoKdWOqs4-w5Euy430E8VMDlB5JGdo7f_D-I7CLT-GlLHjGqbyMlrNJx4uET_9lpKPIUCQ-_m4vfwVjAqhLdSO6KQxdRUME4tdooNE0xDX7qyrr_jJP8xoaGsWyIN=s600";

    for (const message of batch.messages) {
      const { postId } = message.body;
      try {
        const post = await env.DB.prepare(
          `SELECT * FROM posts_cache WHERE post_id = ?`
        ).bind(postId).first();

        if (!post) { message.ack(); continue; }

        const notifUrl = resolveNotifUrl(env, post.url, post.post_id);

        const richPayload = {
          title:  post.title,
          body:   post.excerpt || "Tap to read the full story.",
          image:  post.featured_image || FALLBACK_IMAGE,
          icon:   "https://www.liyogworld.com.ng/favicon.ico",
          badge:  "https://www.liyogworld.com.ng/favicon.ico",
          url:    notifUrl,
          postId: post.post_id,
        };

        // Web push fan-out
        const { results: webSubs } = await env.DB.prepare(
          `SELECT * FROM push_subscriptions WHERE active = 1`
        ).all();

        for (const sub of webSubs || []) {
          try {
            const result = await sendWebPush({ subscription: sub, payload: richPayload, env });
            await env.DB.prepare(
              `INSERT INTO notification_log
                 (post_id, recipient_type, recipient_ref, status, sent_at, error)
               VALUES (?, 'web', ?, ?, datetime('now'), ?)`
            ).bind(
              post.post_id, sub.endpoint,
              result.ok ? "sent" : "failed", result.body || null
            ).run();
            if (result.status === 404 || result.status === 410) {
              await env.DB.prepare(
                `UPDATE push_subscriptions SET active = 0 WHERE endpoint = ?`
              ).bind(sub.endpoint).run();
            }
          } catch (err) {
            console.error("[queue] web push failed:", err.message);
          }
        }

        // FCM fan-out (dormant until app secrets set)
        const { results: devices } = await env.DB.prepare(
          `SELECT * FROM device_tokens WHERE active = 1`
        ).all();
        for (const device of devices || []) {
          try {
            const result = await sendFcmPush({ token: device.fcm_token, payload: richPayload, env });
            if (!result.skipped) {
              await env.DB.prepare(
                `INSERT INTO notification_log
                   (post_id, recipient_type, recipient_ref, status, sent_at, error)
                 VALUES (?, 'device', ?, ?, datetime('now'), ?)`
              ).bind(
                post.post_id, device.fcm_token,
                result.ok ? "sent" : "failed", result.body || null
              ).run();
            }
          } catch (err) {
            console.error("[queue] FCM failed:", err.message);
          }
        }

        await env.DB.prepare(
          `UPDATE posts_cache SET notified = 1 WHERE post_id = ?`
        ).bind(post.post_id).run();

        console.log(`[queue] dispatched ${post.post_id} → ${(webSubs||[]).length} web, ${(devices||[]).length} device`);
      } catch (err) {
        console.error("[queue] item error:", err);
      }
      message.ack();
    }
  },
};
