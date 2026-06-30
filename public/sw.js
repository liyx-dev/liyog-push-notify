// public/sw.js — register this at your blog's root scope, e.g.
// navigator.serviceWorker.register('/sw.js')
// (For Blogger, host this file on a path served at your domain root —
// e.g. via a Cloudflare Worker route or your existing static asset setup,
// since a service worker's scope is limited to the folder it's served from.)

self.addEventListener("push", (event) => {
  if (!event.data) return;
  const payload = event.data.json();

  const options = {
    body: payload.body,
    icon: payload.icon || "/icons/notification-icon.png",
    badge: payload.badge || "/icons/badge.png",
    image: payload.image, // renders as a big picture in supporting browsers (Chrome/Android)
    data: { url: payload.url, feedUrl: payload.feedUrl, postId: payload.postId },
    actions: [
      { action: "open", title: "Read now" },
      { action: "feed", title: "See latest posts" },
    ],
    tag: `post-${payload.postId}`, // collapses duplicate notifications for the same post
    renotify: false,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const { url, feedUrl, postId } = event.notification.data || {};
  const target = event.action === "feed" ? feedUrl : url;

  event.waitUntil(
    (async () => {
      // fire-and-forget open tracking
      try {
        const ref = self.registration.pushManager
          ? (await self.registration.pushManager.getSubscription())?.endpoint
          : null;
        if (ref) {
          fetch(`/api/track/open?post_id=${encodeURIComponent(postId)}&ref=${encodeURIComponent(ref)}`);
        }
      } catch (e) {
        /* tracking is best-effort */
      }

      const allClients = await clients.matchAll({ type: "window" });
      const existing = allClients.find((c) => c.url === target);
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })()
  );
});
