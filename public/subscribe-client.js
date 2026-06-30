// public/subscribe-client.js
// Drop a <script src="https://www.liyogworld.com.ng/subscribe-client.js"></script>
// tag into your Blogger template (right before </body>). That's it — no
// other HTML elements needed, this builds and shows its own prompt.

const API_BASE = "https://liyog-push-notify.goddayprincess1.workers.dev";
const SNOOZE_MINUTES = 60 * 24; // re-show 24h after someone taps "Later"
const SHOW_DELAY_MS = 3000;     // wait 3s after page load before showing the prompt
const SNOOZE_KEY = "liyog_push_snoozed_until";

function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    #liyog-push-prompt {
      position: fixed;
      left: 12px;
      right: 12px;
      bottom: -200px;
      max-width: 480px;
      margin: 0 auto;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.25);
      padding: 18px 18px 16px;
      display: flex;
      align-items: flex-start;
      gap: 14px;
      z-index: 99999;
      font-family: 'DM Sans', sans-serif;
      transition: bottom 0.4s ease;
    }
    #liyog-push-prompt.liyog-show { bottom: 18px; }
    #liyog-push-prompt .liyog-bell {
      width: 40px;
      height: 40px;
      flex-shrink: 0;
      border-radius: 50%;
      background: linear-gradient(145deg, #28A428, #FFD700);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 19px;
    }
    #liyog-push-prompt .liyog-text {
      flex: 1;
      font-size: 14px;
      color: #222;
      line-height: 1.4;
    }
    #liyog-push-prompt .liyog-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
    }
    #liyog-push-prompt button {
      border: none;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      font-weight: 600;
    }
    #liyog-push-prompt .liyog-subscribe-btn {
      background: #28A428;
      color: #fff;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      white-space: nowrap;
    }
    #liyog-push-prompt .liyog-later-btn {
      background: transparent;
      color: #888;
      font-size: 12px;
      padding: 2px 4px;
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

async function isAlreadySubscribed() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return true; // unsupported = don't prompt
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch (e) {
    return false;
  }
}

function isSnoozed() {
  const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
  return Date.now() < until;
}

function snooze() {
  localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MINUTES * 60 * 1000));
}

async function subscribeNow(promptEl) {
  try {
    if (Notification.permission === "denied") {
      alert("Notifications are blocked for this site in your browser settings. Enable them from your browser's site settings to subscribe.");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      snooze();
      hidePrompt(promptEl);
      return;
    }

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

    hidePrompt(promptEl);
  } catch (err) {
    console.error("Subscribe failed:", err);
    alert("Something went wrong subscribing. Please try again.");
  }
}

function hidePrompt(promptEl) {
  promptEl.classList.remove("liyog-show");
  setTimeout(() => promptEl.remove(), 400);
}

function buildPrompt() {
  const el = document.createElement("div");
  el.id = "liyog-push-prompt";
  el.innerHTML = `
    <div class="liyog-bell">🔔</div>
    <div class="liyog-text">Subscribe to notifications for the latest posts from Liyog World Global. You can disable anytime.</div>
    <div class="liyog-actions">
      <button class="liyog-subscribe-btn">Subscribe</button>
      <button class="liyog-later-btn">Later</button>
    </div>
  `;
  document.body.appendChild(el);

  el.querySelector(".liyog-subscribe-btn").addEventListener("click", () => subscribeNow(el));
  el.querySelector(".liyog-later-btn").addEventListener("click", () => {
    snooze();
    hidePrompt(el);
  });

  requestAnimationFrame(() => el.classList.add("liyog-show"));
}

document.addEventListener("DOMContentLoaded", async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (Notification.permission === "denied") return;
  if (isSnoozed()) return;

  injectStyles();

  const alreadySubscribed = await isAlreadySubscribed();
  if (alreadySubscribed) return;

  setTimeout(buildPrompt, SHOW_DELAY_MS);
});
