// ============================================================
// Web Push implementation for Cloudflare Workers.
//
// IMPORTANT: the popular npm package "web-push" does NOT run in
// Workers — it depends on Node's `crypto` module. This file
// re-implements the same spec (RFC 8291 message encryption +
// RFC 8292 VAPID auth) using only the standard Web Crypto API
// (`crypto.subtle`), which Workers fully supports.
// ============================================================

function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

// ---- VAPID: builds the Authorization header value -----------------
async function buildVapidHeader({ endpoint, subject, publicKeyB64url, privateKeyJwk }) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;

  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12h
    sub: subject,
  };

  const enc = (obj) => bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc(header)}.${enc(payload)}`;

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    typeof privateKeyJwk === "string" ? JSON.parse(privateKeyJwk) : privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(unsigned)
  );

  const jwt = `${unsigned}.${bytesToB64url(new Uint8Array(sigBuf))}`;
  return `vapid t=${jwt}, k=${publicKeyB64url}`;
}

// ---- RFC 8291 message encryption (aes128gcm) -----------------------
async function encryptPayload({ payloadBytes, p256dhB64url, authB64url }) {
  const uaPublicBytes = b64urlToBytes(p256dhB64url); // subscriber's public key, 65 bytes uncompressed
  const authSecret = b64urlToBytes(authB64url);      // 16 bytes

  // Server's ephemeral ECDH keypair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const asPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeyPair.publicKey)
  );

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey },
    serverKeyPair.privateKey,
    256
  );
  const ecdhSecret = new Uint8Array(sharedSecretBits);

  // Step 1: PRK_key = HMAC(auth_secret, ecdh_secret)
  const prkKey = await hmacSha256(authSecret, ecdhSecret);

  // Step 2: IKM = HMAC(PRK_key, "WebPush: info" || 0x00 || ua_pub || as_pub || 0x01)
  const keyInfo = concatBytes(
    new TextEncoder().encode("WebPush: info"),
    new Uint8Array([0]),
    uaPublicBytes,
    asPublicBytes,
    new Uint8Array([1])
  );
  const ikmFull = await hmacSha256(prkKey, keyInfo);
  const ikm = ikmFull.slice(0, 32);

  // Per-message salt (16 random bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Step 3: PRK = HMAC(salt, IKM)
  const prk = await hmacSha256(salt, ikm);

  // Step 4: CEK = HMAC(PRK, "Content-Encoding: aes128gcm" || 0x00 || 0x01)[0:16]
  const cekInfo = concatBytes(
    new TextEncoder().encode("Content-Encoding: aes128gcm"),
    new Uint8Array([0, 1])
  );
  const cekFull = await hmacSha256(prk, cekInfo);
  const cek = cekFull.slice(0, 16);

  // Step 5: NONCE = HMAC(PRK, "Content-Encoding: nonce" || 0x00 || 0x01)[0:12]
  const nonceInfo = concatBytes(
    new TextEncoder().encode("Content-Encoding: nonce"),
    new Uint8Array([0, 1])
  );
  const nonceFull = await hmacSha256(prk, nonceInfo);
  const nonce = nonceFull.slice(0, 12);

  // Plaintext gets a single 0x02 delimiter byte appended (no padding needed for small payloads)
  const plaintext = concatBytes(payloadBytes, new Uint8Array([2]));

  const cryptoKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cryptoKey,
    plaintext
  );
  const ciphertext = new Uint8Array(ciphertextBuf);

  // aes128gcm record header: salt(16) || recordSize(4, BE) || idlen(1) || keyid(as_pub, 65)
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const header = concatBytes(salt, recordSize, new Uint8Array([asPublicBytes.length]), asPublicBytes);

  return concatBytes(header, ciphertext);
}

// ---- Public API: send one push message -----------------------------
export async function sendWebPush({ subscription, payload, env, ttlSeconds = 60 }) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

  const body = await encryptPayload({
    payloadBytes,
    p256dhB64url: subscription.p256dh,
    authB64url: subscription.auth,
  });

  const authHeader = await buildVapidHeader({
    endpoint: subscription.endpoint,
    subject: env.VAPID_SUBJECT,
    publicKeyB64url: env.VAPID_PUBLIC_KEY,
    privateKeyJwk: env.VAPID_PRIVATE_KEY,
  });

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String(ttlSeconds),
      Authorization: authHeader,
    },
    body,
  });

  return { ok: res.ok, status: res.status, body: res.ok ? null : await res.text() };
}
