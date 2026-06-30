// public/subscribe-client.js
// Drop a <script src="/subscribe-client.js" defer></script> tag into your
// Blogger template (right before </body>). Update API_BASE below to your
// deployed Worker URL once you have it.

const API_BASE = "https://liyog-push-notify.goddayprincess1.workers.dev/"; // <-- replace after deploy

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function enablePushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("Push not supported in this browser.");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

  const registration = await navigator.serviceWorker.register("/sw.js");
  const { publicKey } = await fetch(`${API_BASE}/api/push/vapid-public-key`).then((r) => r.json());

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await fetch(`${API_BASE}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
}

// ---- "What's New" scrollable feed panel (premium bell-icon style) ----
async function renderFeedPanel(containerEl) {
  const res = await fetch(`${API_BASE}/api/feed?platform=web&limit=4`);
  const { items, ads } = await res.json();

  containerEl.innerHTML = `
    <div class="liyog-feed-scroll">
      ${items
        .map(
          (post) => `
        <a class="liyog-feed-card" href="${post.url}">
          <img src="${post.featured_image || "/icons/placeholder.jpg"}" alt="" loading="lazy" />
          <span class="liyog-feed-title">${post.title}</span>
        </a>`
        )
        .join("")}
    </div>
    ${ads.network === "adsense" ? '<div class="liyog-ad-slot" data-network="adsense"></div>' : ""}
  `;
}

document.addEventListener("DOMContentLoaded", () => {
  const bell = document.getElementById("liyog-notify-bell"); // add this element to your template
  if (bell) bell.addEventListener("click", enablePushNotifications);

  const feedContainer = document.getElementById("liyog-feed-panel"); // add this element where you want the scroll feed
  if (feedContainer) renderFeedPanel(feedContainer);
});
