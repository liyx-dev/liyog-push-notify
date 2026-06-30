// Run locally with: node scripts/generate-vapid-keys.mjs
// Requires Node 19+ (global crypto.subtle) — or run `node --experimental-global-webcrypto` on older Node.
//
// Prints the two values you need to set as Worker secrets:
//   wrangler secret put VAPID_PUBLIC_KEY
//   wrangler secret put VAPID_PRIVATE_KEY
//
// The public key is also the one your blog's client JS uses to call
// pushManager.subscribe({ applicationServerKey: VAPID_PUBLIC_KEY }).

function toBase64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const { subtle } = globalThis.crypto;

const keyPair = await subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

const rawPublic = await subtle.exportKey("raw", keyPair.publicKey);
const jwkPrivate = await subtle.exportKey("jwk", keyPair.privateKey);

console.log("\n=== VAPID_PUBLIC_KEY (paste as-is) ===");
console.log(toBase64Url(rawPublic));

console.log("\n=== VAPID_PRIVATE_KEY (paste as-is, it's a JSON string) ===");
console.log(JSON.stringify(jwkPrivate));

console.log("\nSet them with:");
console.log("  wrangler secret put VAPID_PUBLIC_KEY");
console.log("  wrangler secret put VAPID_PRIVATE_KEY");
console.log("  wrangler secret put ADMIN_API_KEY   (any long random string you choose)\n");
