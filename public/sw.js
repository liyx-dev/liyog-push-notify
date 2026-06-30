// public/sw.js — register this at your blog's root scope, e.g.
// navigator.serviceWorker.register('/sw.js')

const FALLBACK_URL = "https://www.liyogworld.com.ng/";

self.addEventListener("push", (event) => {
  if (!event.data) return;
  const payload = event.data.json();

  const options = {
    body: payload.body,
    icon: payload.icon || "/icons/notification-icon.png",
    badge: payload.badge || "/icons/badge.png",
    image: payload.image, // renders as a big picture in supporting browsers (Chrome/Android)
    data: { url: payload.url || FALLBACK_URL, postId: payload.postId },
    tag: `post-${payload.postId}`,
    renotify: false,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // Always guaranteed to be a real, valid absolute URL — never null/undefined,
  // which is what was causing the broken-link behavior before.
  const target = (event.notification.data && event.notification.data.url) || FALLBACK_URL;
  const postId = event.notification.data && event.notification.data.postId;

  event.waitUntil(
    (async () => {
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub && postId) {
          fetch(`/api/track/open?post_id=${encodeURIComponent(postId)}&ref=${encodeURIComponent(sub.endpoint)}`);
        }
      } catch (e) {
        /* tracking is best-effort, never block the navigation on it */
      }

      const allClients = await clients.matchAll({ type: "window" });
      const existing = allClients.find((c) => c.url === target);
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })()
  );
});

    
