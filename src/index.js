import { sendWebPush } from "./lib/webpush.js";
import { sendFcmPush } from "./lib/fcm.js";
import { buildSmartFeed } from "./lib/feed.js";
import { fetchNewBloggerPosts } from "./lib/blogger.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your domains in production
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

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
const { pathname } = url;

if (pathname === "/sw.js" || pathname === "/subscribe-client.js") {
  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404) return assetResponse;
}

try {
      // ---- Client gets the VAPID public key before subscribing ----
      if (pathname === "/api/push/vapid-public-key" && request.method === "GET") {
        return json({ publicKey: env.VAPID_PUBLIC_KEY });
      }

      // ---- Save a browser's Web Push subscription ----
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
             active = 1, last_seen_at = datetime('now'), subscriber_id = excluded.subscriber_id`
        )
          .bind(subscriberId || null, endpoint, keys.p256dh, keys.auth, request.headers.get("User-Agent") || "")
          .run();
        return json({ ok: true });
      }

      // ---- Unsubscribe ----
      if (pathname === "/api/push/unsubscribe" && request.method === "POST") {
        const { endpoint } = await request.json();
        await env.DB.prepare(`UPDATE push_subscriptions SET active = 0 WHERE endpoint = ?`)
          .bind(endpoint)
          .run();
        return json({ ok: true });
      }

      // ---- Register an Android/iOS device token (used once the app exists) ----
      if (pathname === "/api/device/register" && request.method === "POST") {
        const { token, platform, subscriberId } = await request.json();
        if (!token) return json({ error: "Missing token" }, 400);
        await env.DB.prepare(
          `INSERT INTO device_tokens (subscriber_id, fcm_token, platform)
           VALUES (?, ?, ?)
           ON CONFLICT(fcm_token) DO UPDATE SET
             active = 1, last_seen_at = datetime('now'), subscriber_id = excluded.subscriber_id`
        )
          .bind(subscriberId || null, token, platform || "android")
          .run();
        return json({ ok: true });
      }

      // ---- Smart scrollable feed (web "What's New" panel AND future app screen) ----
      if (pathname === "/api/feed" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") || 4);
        const platform = url.searchParams.get("platform") === "app" ? "app" : "web";
        const items = await buildSmartFeed(env.DB, limit);
        return json({
          platform,
          ads: platform === "app" ? { network: "admob" } : { network: "adsense" },
          items,
        });
      }

      // ---- Mark a notification as opened (for analytics) ----
      if (pathname === "/api/track/open" && request.method === "GET") {
        const postId = url.searchParams.get("post_id");
        const ref = url.searchParams.get("ref");
        if (postId && ref) {
          await env.DB.prepare(
            `UPDATE notification_log SET status='opened', opened_at=datetime('now')
             WHERE post_id=? AND recipient_ref=?`
          )
            .bind(postId, ref)
            .run();
          await env.DB.prepare(
            `UPDATE posts_cache SET popularity_score = popularity_score + 1 WHERE post_id = ?`
          )
            .bind(postId)
            .run();
        }
        return json({ ok: true });
      }

      // ---- Admin/dashboard-triggered manual post insert + notify ----
      // (Normally the cron below catches new posts automatically; this is
      // for re-sending or for posts published outside Blogger.)
      if (pathname === "/internal/posts/new" && request.method === "POST") {
        if (request.headers.get("X-Admin-Key") !== env.ADMIN_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        const post = await request.json();
        await env.DB.prepare(
          `INSERT INTO posts_cache (post_id, title, url, featured_image, excerpt, category, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(post_id) DO UPDATE SET
             title=excluded.title, url=excluded.url, featured_image=excluded.featured_image,
             excerpt=excluded.excerpt, category=excluded.category`
        )
          .bind(
            post.postId,
            post.title,
            post.url,
            post.featuredImage || null,
            post.excerpt || null,
            post.category || null,
            post.publishedAt || new Date().toISOString()
          )
          .run();

        await queueNotifyForPost(env, post.postId);
        return json({ ok: true, queued: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Internal error", message: err.message }, 500);
    }
  },

  // ---- Cron: poll Blogger every 10 minutes, cache + notify on new posts ----
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const newPosts = await fetchNewBloggerPosts(env.DB, env.BLOG_FEED_URL);
          for (const post of newPosts) {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO posts_cache
                 (post_id, title, url, featured_image, excerpt, category, published_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
              .bind(
                post.postId,
                post.title,
                post.url,
                post.featuredImage,
                post.excerpt,
                post.category,
                post.publishedAt
              )
              .run();
            await queueNotifyForPost(env, post.postId);
          }
        } catch (err) {
          console.error("Cron poll failed:", err);
        }
      })()
    );
  },

  // ---- Queue consumer: fans the rich push out to every active subscriber ----
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const { postId } = message.body;

      const post = await env.DB.prepare(`SELECT * FROM posts_cache WHERE post_id = ?`)
        .bind(postId)
        .first();
      if (!post) {
        message.ack();
        continue;
      }

      const richPayload = {
        title: post.title,
        body: post.excerpt || "Tap to read the full story",
        image: post.featured_image,
        icon: "https://liyogworld.com.ng/icons/notification-icon.png",
        badge: "https://liyogworld.com.ng/icons/badge.png",
        url: post.url,
        feedUrl: env.FEED_PAGE_URL,
        postId: post.post_id,
      };

      // --- Web push fan-out ---
      const webSubs = await env.DB.prepare(
        `SELECT * FROM push_subscriptions WHERE active = 1`
      ).all();

      for (const sub of webSubs.results || []) {
        try {
          const result = await sendWebPush({ subscription: sub, payload: richPayload, env });
          await env.DB.prepare(
            `INSERT INTO notification_log (post_id, recipient_type, recipient_ref, status, sent_at, error)
             VALUES (?, 'web', ?, ?, datetime('now'), ?)`
          )
            .bind(post.post_id, sub.endpoint, result.ok ? "sent" : "failed", result.body || null)
            .run();

          // Push services return 404/410 when a subscription is dead — deactivate it.
          if (result.status === 404 || result.status === 410) {
            await env.DB.prepare(`UPDATE push_subscriptions SET active = 0 WHERE endpoint = ?`)
              .bind(sub.endpoint)
              .run();
          }
        } catch (err) {
          console.error("Web push failed for", sub.endpoint, err.message);
        }
      }

      // --- Device (FCM) fan-out — dormant until the app + secrets exist ---
      const devices = await env.DB.prepare(`SELECT * FROM device_tokens WHERE active = 1`).all();
      for (const device of devices.results || []) {
        try {
          const result = await sendFcmPush({ token: device.fcm_token, payload: richPayload, env });
          if (!result.skipped) {
            await env.DB.prepare(
              `INSERT INTO notification_log (post_id, recipient_type, recipient_ref, status, sent_at, error)
               VALUES (?, 'device', ?, ?, datetime('now'), ?)`
            )
              .bind(post.post_id, device.fcm_token, result.ok ? "sent" : "failed", result.body || null)
              .run();
          }
        } catch (err) {
          console.error("FCM push failed for", device.fcm_token, err.message);
        }
      }

      await env.DB.prepare(`UPDATE posts_cache SET notified = 1 WHERE post_id = ?`)
        .bind(post.post_id)
        .run();

      message.ack();
    }
  },
};
          
