// FCM HTTP v1 sender. The Android app doesn't exist yet, so this stays
// dormant (it no-ops with a clear log) until you set FCM_PROJECT_ID and
// FCM_SERVICE_ACCOUNT secrets once the app is built. The plumbing
// (device_tokens table, notify-dispatch fan-out) is already wired so
// switching it on later needs zero schema or routing changes.

async function getAccessToken(env) {
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT); // service account JSON key
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const enc = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const unsigned = `${enc(header)}.${enc(payload)}`;

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsigned)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const jwt = `${unsigned}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

export async function sendFcmPush({ token, payload, env }) {
  if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT) {
    console.log("FCM not configured yet — skipping device push until the app ships.");
    return { ok: false, skipped: true };
  }

  const accessToken = await getAccessToken(env);

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: payload.title,
            body: payload.body,
            image: payload.image,
          },
          data: { url: payload.url, postId: String(payload.postId) },
          android: { notification: { click_action: "OPEN_POST" } },
        },
      }),
    }
  );

  return { ok: res.ok, status: res.status, body: res.ok ? null : await res.text() };
}
