// public/sw.js — register this at your blog's root scope, e.g.
// navigator.serviceWorker.register('/sw.js')
const FALLBACK_URL = "https://www.liyogworld.com.ng/";

self.addEventListener("push", (event) => {
  if (!event.data) return;
  const payload = event.data.json();
  const options = {
    body: payload.body,
    icon: payload.icon || FALLBACK_URL + "favicon.ico",
    badge: payload.badge || FALLBACK_URL + "favicon.ico",
    image: payload.image,
    data: { url: payload.url || FALLBACK_URL, postId: payload.postId },
    tag: `post-${payload.postId}`,
    renotify: false,
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || FALLBACK_URL;
  const postId = event.notification.data && event.notification.data.postId;
  event.waitUntil((async () => {
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub && postId) {
        fetch(`/api/track/open?post_id=${encodeURIComponent(postId)}&ref=${encodeURIComponent(sub.endpoint)}`);
      }
    } catch (e) {}
    const allClients = await clients.matchAll({ type: "window" });
    const existing = allClients.find((c) => c.url === target);
    if (existing) return existing.focus();
    return clients.openWindow(target);
  })());
});

