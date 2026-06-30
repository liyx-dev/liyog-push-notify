// public/subscribe-client.js
// Drop a <script src="https://liyogworld.com.ng/subscribe-client.js"></script>
// tag into your Blogger template (right before </body>).

const API_BASE = "https://liyog-push-notify.goddayprincess1.workers.dev"; // no trailing slash

function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    #liyog-notify-bell {
      position: fixed;
      bottom: 22px;
      right: 18px;
      z-index: 9999;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: none;
      background: linear-gradient(145deg, #28A428, #FFD700);
      color: #111;
      font-size: 24px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      cursor: pointer;
    }
    #liyog-feed-section {
      max-width: 100%;
      padding: 20px 14px 60px;
      background: #111111;
    }
    .liyog-feed-heading {
      color: #FFD700;
      font-family: 'Syne', sans-serif;
      font-weight: 800;
      font-size: 18px;
      margin: 0 0 14px 4px;
    }
    .liyog-feed-scroll {
      display: flex;
      overflow-x: auto;
      gap: 14px;
      padding-bottom: 6px;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
    }
    .liyog-feed-card {
      flex: 0 0 160px;
      scroll-snap-align: start;
      background: #1b1b1b;
      border-radius: 14px;
      overflow: hidden;
      text-decoration: none;
      color: #fff;
      box-shadow: 0 4px 14px rgba(0,0,0,0.4);
      display: block;
    }
    .liyog-feed-card img {
      width: 100%;
      height: 110px;
      object-fit: cover;
      display: block;
      background: #2a2a2a;
    }
    .liyog-feed-title {
      display: block;
      padding: 10px 12px 14px;
      font-family: 'DM Sans', sans-serif;
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1.35;
    }
    .liyog-ad-slot {
      flex: 0 0 160px;
      border-radius: 14px;
      background: #1b1b1b;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #777;
      font-size: 11px;
    }
  `;
  document.head.appendChild(style);
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function enablePushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("Push notifications aren't supported in this browser.");
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

  alert("You're subscribed! You'll be notified of new posts.");
}

async function renderFeedPanel(containerEl) {
  const res = await fetch(`${API_BASE}/api/feed?platform=web&limit=4`);
  const { items, ads } = await res.json();

  const cards = items
    .map(
      (post) => `
      <a class="liyog-feed-card" href="${post.url}">
        <img src="${post.featured_image || ""}"
             onerror="this.style.display='none'" alt="" loading="lazy" />
        <span class="liyog-feed-title">${post.title}</span>
      </a>`
    )
    .join("");

  const adSlot = ads.network === "adsense" ? `<div class="liyog-ad-slot" data-network="adsense">Ad</div>` : "";

  containerEl.innerHTML = `<div class="liyog-feed-scroll">${cards}${adSlot}</div>`;
}

document.addEventListener("DOMContentLoaded", () => {
  injectStyles();

  const bell = document.getElementById("liyog-notify-bell");
  if (bell) bell.addEventListener("click", enablePushNotifications);

  const feedContainer = document.getElementById("liyog-feed-panel");
  if (feedContainer) renderFeedPanel(feedContainer);
});
