// ============================================================
// Liyog World Global Codes — Admin Dashboard Worker
// Serves the admin login page, the dashboard UI, and a JSON API
// behind authentication. This is the control center for the
// entire notification system — subscriber management, custom
// broadcasts, system health, and manual worker triggers.
// ============================================================

const SITE_NAME = "Liyog World Global";
const SITE_URL = "https://www.liyogworld.com.ng";
const LOGO_URL = "https://blogger.googleusercontent.com/img/a/AVvXsEhU2MxWUfqe3_mL2XlAzymc4I4AT97rIsEO8Cxk288oU2p8leSdh2wXOdZHR3YgOkjVoKdWOqs4-w5Euy430E8VMDlB5JGdo7f_D-I7CLT-GlLHjGqbyMlrNJx4uET_9lpKPIUCQ-_m4vfwVjAqhLdSO6KQxdRUME4tdooNE0xDX7qyrr_jJP8xoaGsWyIN=s1200";

// Other Workers in the system — the admin Worker calls these directly
// so we never duplicate their logic, only orchestrate them.
const FEED_CHECK_URL = "https://liyog-feed-check.goddayprincess1.workers.dev";
const EMAIL_SENDER_URL = "https://liyog-email-sender.goddayprincess1.workers.dev";
const CONFIRM_WORKER_URL = "https://liyog-confirm.goddayprincess1.workers.dev";

const PASSWORD_SALT = "liyog-admin-fixed-salt-v1"; // fixed salt is fine here since this protects against rainbow tables on a single-admin system, not multi-user credential stuffing

const C = {
  green: "#28A428",
  greenLight: "#34BF49",
  greenDark: "#228B22",
  deepGreen: "#006400",
  gold: "#FFD700",
  orange: "#FF7A00",
  blue: "#1877F2",
  black: "#111111",
  blackLight: "#1A1A1A",
  red: "#FF3B30",
  redDark: "#C1271A",
  yellow: "#FFEA00",
};

// ---------- Password hashing (Web Crypto, native to Workers) ----------

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(PASSWORD_SALT + password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Session management ----------

async function createSession(env, adminUserId) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7 days
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token, admin_user_id, expires_at) VALUES (?, ?, ?)"
  ).bind(token, adminUserId, expiresAt).run();
  return token;
}

// ---------- Password recovery (recovery code, set in advance while logged in) ----------

async function setRecoveryCode(env, adminUserId, recoveryCode) {
  const hash = await hashPassword(recoveryCode); // reuses the same salted hash function
  await env.DB.prepare(
    "UPDATE admin_users SET recovery_code_hash = ? WHERE id = ?"
  ).bind(hash, adminUserId).run();
}

async function resetPasswordWithRecoveryCode(env, username, recoveryCode, newPassword) {
  const user = await env.DB.prepare(
    "SELECT id, recovery_code_hash FROM admin_users WHERE username = ?"
  ).bind(username).first();
  if (!user || !user.recovery_code_hash) {
    return { success: false, error: "No recovery code is set up for this account." };
  }
  const attemptedHash = await hashPassword(recoveryCode);
  if (attemptedHash !== user.recovery_code_hash) {
    return { success: false, error: "Recovery code is incorrect." };
  }
  const newHash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").bind(newHash, user.id).run();
  // Invalidate all existing sessions on password reset, as a safety measure.
  await env.DB.prepare("DELETE FROM admin_sessions WHERE admin_user_id = ?").bind(user.id).run();
  return { success: true };
}

async function getSessionUser(env, token) {
  if (!token) return null;
  const session = await env.DB.prepare(
    "SELECT admin_user_id, expires_at FROM admin_sessions WHERE token = ?"
  ).bind(token).first();
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return session.admin_user_id;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function requireAuth(request, env) {
  const token = getCookie(request, "liyog_admin_session");
  const userId = await getSessionUser(env, token);
  return userId; // null if not authenticated
}
// ============================================================
// Data access layer — every function the dashboard's API calls
// rely on. Kept separate from routing so each piece is testable
// and readable on its own.
// ============================================================

async function getDashboardOverview(env) {
  const todayDate = new Date().toISOString().slice(0, 10);

  const quotaRow = await env.DB.prepare(
    "SELECT emails_sent FROM quota_usage WHERE usage_date = ?"
  ).bind(todayDate).first();

  const pendingCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM pending_sends WHERE status = 'pending'"
  ).first();

  const subscriberCounts = await env.DB.prepare(
    "SELECT confirmed, COUNT(*) as count FROM subscribers GROUP BY confirmed"
  ).all();

  const feedState = await env.DB.prepare(
    "SELECT last_post_id, last_checked_at FROM feed_state WHERE id = 1"
  ).first();

  const confirmedRow = subscriberCounts.results.find((r) => r.confirmed === 1);
  const unconfirmedRow = subscriberCounts.results.find((r) => r.confirmed === 0);
  const confirmed = confirmedRow ? confirmedRow.count : 0;
  const unconfirmed = unconfirmedRow ? unconfirmedRow.count : 0;

  const sentToday = quotaRow ? quotaRow.emails_sent : 0;
  const dailyLimit = 100;

  return {
    subscribers: { confirmed, unconfirmed, total: confirmed + unconfirmed },
    quota: { sentToday, dailyLimit, remainingToday: Math.max(0, dailyLimit - sentToday), date: todayDate },
    spillover: { pendingCount: pendingCount ? pendingCount.count : 0 },
    feed: {
      lastDetectedPostId: feedState ? feedState.last_post_id : null,
      lastCheckedAt: feedState ? feedState.last_checked_at : null,
    },
  };
}

async function getSendLog(env, limit = 50) {
  const rows = await env.DB.prepare(
    "SELECT recipient, email_type, subject, status, provider, error_message, created_at FROM send_log ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all();
  return rows.results;
}

async function searchSubscribers(env, { query = "", confirmedFilter = "all", limit = 200 }) {
  let sql = "SELECT id, email, confirmed, created_at, confirmed_at FROM subscribers WHERE 1=1";
  const binds = [];

  if (query) {
    sql += " AND email LIKE ?";
    binds.push(`%${query}%`);
  }
  if (confirmedFilter === "confirmed") {
    sql += " AND confirmed = 1";
  } else if (confirmedFilter === "unconfirmed") {
    sql += " AND confirmed = 0";
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return rows.results;
}

async function setSubscriberConfirmed(env, emails, confirmedValue) {
  // Used both for admin-initiated unsubscribe (confirmedValue = 0) and for
  // admin-initiated "subscribe without confirmation email" (confirmedValue = 1).
  let updated = 0;
  for (const email of emails) {
    const result = await env.DB.prepare(
      "UPDATE subscribers SET confirmed = ?, confirmed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE confirmed_at END WHERE email = ?"
    ).bind(confirmedValue, confirmedValue, email).run();
    if (result.meta && result.meta.changes > 0) updated++;
  }
  return updated;
}

async function deleteSubscribersCompletely(env, emails) {
  // Permanently removes the row entirely — distinct from unsubscribe, which
  // only sets confirmed = 0 and keeps the record (so re-subscribing later
  // doesn't create a duplicate, and history/logs still make sense). Deletion
  // is for cases like spam addresses, typos, or a genuine "forget this
  // person entirely" request.
  let deleted = 0;
  for (const email of emails) {
    const result = await env.DB.prepare("DELETE FROM subscribers WHERE email = ?").bind(email).run();
    if (result.meta && result.meta.changes > 0) deleted++;
  }
  return deleted;
}

async function addSubscriberDirectly(env, email) {
  // Admin-added subscriber, pre-confirmed, no confirmation email sent.
  const existing = await env.DB.prepare("SELECT id FROM subscribers WHERE email = ?").bind(email).first();
  if (existing) {
    await env.DB.prepare(
      "UPDATE subscribers SET confirmed = 1, confirmed_at = datetime('now') WHERE email = ?"
    ).bind(email).run();
    return { created: false, updated: true };
  }
  const confirmToken = crypto.randomUUID();
  const unsubToken = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO subscribers (email, confirm_token, confirmed, unsubscribe_token, confirmed_at)
     VALUES (?, ?, 1, ?, datetime('now'))`
  ).bind(email, confirmToken, unsubToken).run();
  return { created: true, updated: false };
}

async function resolveTargetEmails(env, targetType, explicitEmails) {
  if (targetType === "selected") {
    return explicitEmails || [];
  }
  let sql = "SELECT email FROM subscribers WHERE 1=1";
  if (targetType === "all_confirmed") sql += " AND confirmed = 1";
  else if (targetType === "all_unconfirmed") sql += " AND confirmed = 0";
  // targetType === "everyone" applies no filter at all
  const rows = await env.DB.prepare(sql).all();
  return rows.results.map((r) => r.email);
}

async function createAdminMessage(env, { subject, bodyHtml, imageUrl, ctaLink, ctaLabel, targetType, targetEmails }) {
  const deleteAfter = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7 days, per requirement
  const result = await env.DB.prepare(
    `INSERT INTO admin_messages (subject, body_html, image_url, status, target_type, target_emails, cta_link, cta_label, delete_after)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
  ).bind(
    subject, bodyHtml, imageUrl || null, targetType,
    targetEmails ? JSON.stringify(targetEmails) : null,
    ctaLink || null, ctaLabel || null, deleteAfter
  ).run();
  return result.meta.last_row_id;
}

async function getAdminMessage(env, id) {
  return await env.DB.prepare("SELECT * FROM admin_messages WHERE id = ?").bind(id).first();
}

async function markAdminMessageSent(env, id, totalRecipients) {
  await env.DB.prepare(
    "UPDATE admin_messages SET status = 'sent', total_recipients = ? WHERE id = ?"
  ).bind(totalRecipients, id).run();
}

async function getRecentAdminMessages(env, limit = 20) {
  const rows = await env.DB.prepare(
    "SELECT id, subject, status, target_type, total_recipients, sent_count, created_at FROM admin_messages ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all();
  return rows.results;
}

async function deleteExpiredAdminMessages(env) {
  const result = await env.DB.prepare(
    "DELETE FROM admin_messages WHERE delete_after IS NOT NULL AND delete_after <= datetime('now')"
  ).run();
  return result.meta ? result.meta.changes : 0;
}
// ============================================================
// Custom broadcast email builder + dispatcher.
// Reuses the SAME premium dark design language as the automatic
// new-post emails, so every email a subscriber receives — automatic
// or admin-composed — feels like it came from the same brand.
// Dispatches through the existing liyog-email-queue, so the
// quota-aware spillover logic (built for new-post notifications)
// protects custom broadcasts too, with zero extra code needed.
// ============================================================

function escapeHtmlAdmin(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildAdminBroadcastHtml({ subject, bodyHtml, imageUrl, ctaLink, ctaLabel }) {
  // bodyHtml is allowed to contain admin-authored hyperlinks (e.g. "click
  // <a href=...>here</a> to read more") since this is a trusted, logged-in
  // admin composing it — not user-submitted content, so no escaping of
  // bodyHtml itself, only of plain-text fields like subject.
  const imageBlock = imageUrl
    ? `<div style="border-radius:14px;overflow:hidden;margin-bottom:22px;">
         <img src="${imageUrl}" alt="${escapeHtmlAdmin(subject)}" width="100%" style="display:block;width:100%;max-height:320px;object-fit:cover;" />
       </div>`
    : "";

  const ctaBlock = ctaLink
    ? `<div style="text-align:center;margin-top:28px;">
         <a href="${ctaLink}" style="display:inline-block;background:#FFD700;color:#111111;padding:15px 34px;
           border-radius:10px;text-decoration:none;font-weight:800;font-size:14.5px;letter-spacing:0.01em;">${escapeHtmlAdmin(ctaLabel || "Learn More")} →</a>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#111111;">
<div style="background:#111111;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#1A1A1A;">

    <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #2a2a2a;">
      <img src="${LOGO_URL}" alt="${SITE_NAME}" width="48" height="48"
        style="border-radius:50%;display:block;margin:0 auto 14px;border:2px solid #28A428;object-fit:cover;" />
      <h1 style="margin:0;color:#ffffff;font-size:21px;font-weight:800;letter-spacing:-0.01em;">LIYOG WORLD GLOBAL</h1>
      <p style="margin:8px 0 0;color:#FFD700;font-size:11.5px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;">Faith &nbsp;/&nbsp; Purpose &nbsp;/&nbsp; Impact</p>
    </td></tr>

    <tr><td style="padding:40px 40px 8px;">
      ${imageBlock}
      <h2 style="color:#ffffff;font-size:22px;margin:0 0 18px;font-weight:700;line-height:1.35;">${escapeHtmlAdmin(subject)}</h2>
      <div style="font-size:15px;color:#c4c4c4;line-height:1.7;">${bodyHtml}</div>
      ${ctaBlock}
    </td></tr>

    <tr><td style="padding:36px 40px 0;">
      <div style="border-top:1px solid #2a2a2a;"></div>
    </td></tr>

    <tr><td style="background:#000000;padding:24px 40px;text-align:center;">
      <p style="margin:0 0 8px;color:#666;font-size:11.5px;">You're receiving this because you subscribed at <a href="${SITE_URL}" style="color:#34BF49;text-decoration:none;">liyogworld.com.ng</a></p>
      <p style="margin:0;font-size:11px;">
        <a href="{{UNSUBSCRIBE_URL}}" style="color:#666;text-decoration:underline;">Unsubscribe</a>
        <span style="color:#444;"> &nbsp;·&nbsp; </span>
        <span style="color:#666;">Liyog World Global, Onitsha, Anambra State, Nigeria</span>
      </p>
    </td></tr>

  </table>
</div>
</body></html>`;
}

async function dispatchAdminBroadcast(env, messageId) {
  const message = await getAdminMessage(env, messageId);
  if (!message) throw new Error("Admin message not found");

  let emails;
  if (message.target_type === "selected" && message.target_emails) {
    emails = JSON.parse(message.target_emails);
  } else {
    emails = await resolveTargetEmails(env, message.target_type, null);
  }

  if (emails.length === 0) {
    throw new Error("No recipients matched the selected target — nothing was sent.");
  }

  const html = buildAdminBroadcastHtml({
    subject: message.subject,
    bodyHtml: message.body_html,
    imageUrl: message.image_url,
    ctaLink: message.cta_link,
    ctaLabel: message.cta_label,
  });

  const CHUNK_SIZE = 100;
  const chunks = [];
  for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
    chunks.push(emails.slice(i, i + CHUNK_SIZE));
  }

  for (const chunk of chunks) {
    await env.EMAIL_QUEUE.send({
      type: "admin_broadcast",
      subject: message.subject,
      html, // contains {{UNSUBSCRIBE_URL}} placeholder, replaced per-recipient by liyog-email-sender
      emails: chunk,
    });
  }

  await markAdminMessageSent(env, messageId, emails.length);
  return { recipientCount: emails.length, batchCount: chunks.length };
}
// ============================================================
// Login page — shown to anyone not yet authenticated.
// ============================================================

function loginPageHtml(errorMessage) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${SITE_NAME} — Admin Login</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:${C.black};color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
  .box{background:${C.blackLight};border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:48px 40px;max-width:380px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,0.5);}
  .logo{width:56px;height:56px;border-radius:50%;border:2px solid ${C.green};display:block;margin:0 auto 18px;object-fit:cover;}
  h1{text-align:center;font-size:20px;margin:0 0 4px;font-weight:800;}
  p.tag{text-align:center;color:${C.gold};font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;font-weight:700;margin:0 0 30px;}
  label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:#ccc;}
  input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid #333;background:#0d0d0d;color:#fff;font-size:14.5px;margin-bottom:18px;}
  input:focus{outline:2px solid ${C.green};border-color:transparent;}
  button{width:100%;padding:14px;border-radius:10px;border:none;background:${C.green};color:#0a0a0a;font-weight:800;font-size:14.5px;cursor:pointer;}
  button:hover{filter:brightness(1.08);}
  .error{background:rgba(255,59,48,0.12);border:1px solid ${C.red};color:#ff9a94;padding:12px 14px;border-radius:8px;font-size:13.5px;margin-bottom:18px;}
  .forgot-link{display:block;text-align:center;margin-top:16px;font-size:12.5px;color:#888;text-decoration:none;}
  .forgot-link:hover{color:${C.greenLight};}
</style></head>
<body>
  <form class="box" method="POST" action="/login">
    <img src="${LOGO_URL}" alt="${SITE_NAME}" class="logo">
    <h1>${SITE_NAME}</h1>
    <p class="tag">Admin Dashboard</p>
    ${errorMessage ? `<div class="error">${escapeHtmlAdmin(errorMessage)}</div>` : ""}
    <label>Username</label>
    <input type="text" name="username" required autofocus autocomplete="username">
    <label>Password</label>
    <input type="password" name="password" required autocomplete="current-password">
    <button type="submit">Sign In</button>
    <a class="forgot-link" href="/forgot-password">Forgot your password?</a>
  </form>
</body></html>`;
}

function forgotPasswordPageHtml(errorMessage) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${SITE_NAME} — Reset Password</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:${C.black};color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
  .box{background:${C.blackLight};border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:44px 36px;max-width:400px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,0.5);}
  h1{text-align:center;font-size:19px;margin:0 0 8px;font-weight:800;}
  p.sub{text-align:center;color:#999;font-size:13px;margin:0 0 24px;line-height:1.6;}
  label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:#ccc;}
  input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid #333;background:#0d0d0d;color:#fff;font-size:14.5px;margin-bottom:16px;}
  input:focus{outline:2px solid ${C.green};border-color:transparent;}
  button{width:100%;padding:14px;border-radius:10px;border:none;background:${C.green};color:#0a0a0a;font-weight:800;font-size:14.5px;cursor:pointer;}
  .error{background:rgba(255,59,48,0.12);border:1px solid ${C.red};color:#ff9a94;padding:12px 14px;border-radius:8px;font-size:13.5px;margin-bottom:18px;}
  .back-link{display:block;text-align:center;margin-top:16px;font-size:12.5px;color:#888;text-decoration:none;}
</style></head>
<body>
  <form class="box" method="POST" action="/forgot-password">
    <h1>Reset Your Password</h1>
    <p class="sub">Enter your username, your recovery code (set up earlier from inside the dashboard), and your new password.</p>
    ${errorMessage ? `<div class="error">${escapeHtmlAdmin(errorMessage)}</div>` : ""}
    <label>Username</label>
    <input type="text" name="username" required autofocus>
    <label>Recovery Code</label>
    <input type="text" name="recoveryCode" required>
    <label>New Password</label>
    <input type="password" name="newPassword" required minlength="8">
    <button type="submit">Reset Password</button>
    <a class="back-link" href="/login">Back to login</a>
  </form>
</body></html>`;
}
// ============================================================
// Dashboard page — the actual control center, shown once logged in.
// Single-page app: tabs switch sections via JS, all data loaded
// from the JSON API endpoints defined in the router (part 6).
// ============================================================

function dashboardPageHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${SITE_NAME} — Admin Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:${C.black};color:#eee;min-height:100vh;}
  a{color:inherit;}

  .topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:${C.blackLight};border-bottom:1px solid #2a2a2a;position:sticky;top:0;z-index:20;flex-wrap:wrap;gap:10px;}
  .topbar .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:14.5px;}
  .topbar img{width:30px;height:30px;border-radius:50%;border:2px solid ${C.green};object-fit:cover;flex-shrink:0;}
  .logout{background:none;border:1px solid #444;color:#999;padding:8px 14px;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap;}
  .logout:hover{border-color:${C.red};color:${C.red};}

  .tabs{display:flex;gap:2px;padding:0 8px;background:${C.blackLight};overflow-x:auto;border-bottom:1px solid #2a2a2a;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
  .tabs::-webkit-scrollbar{display:none;}
  .tab{padding:13px 14px;font-size:12.5px;font-weight:700;color:#888;cursor:pointer;border-bottom:3px solid transparent;white-space:nowrap;flex-shrink:0;}
  .tab.active{color:#fff;border-bottom-color:${C.green};}

  .content{padding:18px 12px 80px;max-width:1000px;margin:0 auto;width:100%;}
  .panel{display:none;}
  .panel.active{display:block;animation:fadeIn .3s ease;}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}

  .stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;}
  @media(min-width:640px){.stat-grid{grid-template-columns:repeat(4,1fr);gap:12px;}}
  .stat-card{background:${C.blackLight};border-radius:14px;padding:14px;border:1px solid #2a2a2a;min-width:0;}
  .stat-card .num{font-size:22px;font-weight:800;color:${C.greenLight};word-break:break-word;}
  @media(min-width:640px){.stat-card .num{font-size:26px;}}
  .stat-card .label{font-size:10.5px;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-top:4px;}
  .stat-card.warn .num{color:${C.gold};}
  .stat-card.danger .num{color:${C.red};}

  .card{background:${C.blackLight};border-radius:16px;padding:16px;border:1px solid #2a2a2a;margin-bottom:16px;}
  @media(min-width:640px){.card{padding:22px;}}
  .card h3{font-size:14.5px;margin-bottom:14px;color:#fff;}
  .card p.sub{font-size:12.5px;color:#888;margin-bottom:14px;line-height:1.5;}

  .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:11px 16px;border-radius:9px;border:none;font-weight:700;font-size:12.5px;cursor:pointer;transition:filter .2s, transform .2s;white-space:nowrap;}
  .btn:active{transform:scale(0.97);}
  .btn-green{background:${C.green};color:#0a0a0a;}
  .btn-gold{background:${C.gold};color:#111;}
  .btn-ghost{background:transparent;border:1px solid #444;color:#ccc;}
  .btn-danger{background:${C.red};color:#fff;}
  .btn:hover{filter:brightness(1.1);}
  .btn:disabled{opacity:0.5;cursor:not-allowed;}

  table{width:100%;border-collapse:collapse;font-size:12.5px;}
  .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
  th{text-align:left;padding:9px 6px;color:#888;font-weight:600;border-bottom:1px solid #2a2a2a;font-size:10.5px;text-transform:uppercase;letter-spacing:0.03em;white-space:nowrap;}
  td{padding:9px 6px;border-bottom:1px solid #222;word-break:break-word;}
  tr:hover td{background:#202020;}
  .status-pill{display:inline-block;padding:3px 9px;border-radius:20px;font-size:10.5px;font-weight:700;white-space:nowrap;}
  .status-sent{background:rgba(40,164,40,0.15);color:${C.greenLight};}
  .status-failed{background:rgba(255,59,48,0.15);color:${C.red};}
  .status-confirmed{background:rgba(40,164,40,0.15);color:${C.greenLight};}
  .status-unconfirmed{background:rgba(255,215,0,0.15);color:${C.gold};}

  input[type=text], input[type=email], input[type=url], input[type=password], textarea, select{
    width:100%;padding:11px 13px;border-radius:9px;border:1px solid #333;background:#0d0d0d;color:#fff;font-size:14px;margin-bottom:14px;font-family:inherit;
  }
  textarea{min-height:120px;resize:vertical;}
  label{display:block;font-size:12px;font-weight:700;color:#aaa;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.03em;}

  .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center;}
  .toolbar input[type=text]{flex:1 1 160px;min-width:0;margin-bottom:0;}
  .chip{padding:7px 12px;border-radius:20px;font-size:11.5px;font-weight:700;background:#0d0d0d;border:1px solid #333;color:#aaa;cursor:pointer;flex-shrink:0;}
  .chip.active{background:${C.green};color:#0a0a0a;border-color:${C.green};}

  .sub-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #1f1f1f;flex-wrap:wrap;}
  .sub-row input[type=checkbox]{width:16px;height:16px;accent-color:${C.green};flex-shrink:0;}
  .sub-row .email{flex:1 1 140px;font-size:13px;word-break:break-all;min-width:0;}

  .toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);background:#000;color:#fff;padding:13px 22px;border-radius:10px;font-size:13px;font-weight:600;opacity:0;transition:.3s;z-index:50;border:1px solid #333;max-width:90vw;text-align:center;}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
  .toast.success{border-color:${C.green};}
  .toast.error{border-color:${C.red};}

  .empty{color:#666;font-size:13px;text-align:center;padding:30px 0;}
  .preview-box{background:#0d0d0d;border-radius:10px;border:1px solid #333;padding:14px;font-size:13px;color:#aaa;max-height:200px;overflow-y:auto;}

  @media(max-width:480px){
    .topbar .brand span{display:none;}
    .stat-card .num{font-size:20px;}
  }
</style>
</head>
<body>

  <div class="topbar">
    <div class="brand"><img src="${LOGO_URL}" alt="logo"><span>${SITE_NAME} Admin</span></div>
    <button class="logout" onclick="logout()">Sign Out</button>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="overview">Overview</div>
    <div class="tab" data-tab="subscribers">Subscribers</div>
    <div class="tab" data-tab="compose">Compose Broadcast</div>
    <div class="tab" data-tab="logs">Send Logs</div>
    <div class="tab" data-tab="system">System Health</div>
    <div class="tab" data-tab="settings">Settings</div>
  </div>

  <div class="content">

    <!-- ============ OVERVIEW ============ -->
    <div class="panel active" id="panel-overview">
      <div class="stat-grid" id="overview-stats">
        <div class="stat-card"><div class="num">—</div><div class="label">Confirmed Subscribers</div></div>
        <div class="stat-card"><div class="num">—</div><div class="label">Unconfirmed</div></div>
        <div class="stat-card"><div class="num">—</div><div class="label">Sent Today</div></div>
        <div class="stat-card"><div class="num">—</div><div class="label">Pending Spillover</div></div>
      </div>
      <div class="card">
        <h3>Recent Broadcasts</h3>
        <div id="recent-broadcasts"><div class="empty">Loading…</div></div>
      </div>
    </div>

    <!-- ============ SUBSCRIBERS ============ -->
    <div class="panel" id="panel-subscribers">
      <div class="card">
        <h3>Manage Subscribers</h3>
        <div class="toolbar">
          <input type="text" id="sub-search" placeholder="Search by email…">
          <span class="chip active" data-filter="all">All</span>
          <span class="chip" data-filter="confirmed">Confirmed</span>
          <span class="chip" data-filter="unconfirmed">Unconfirmed</span>
        </div>
        <div class="toolbar">
          <button class="btn btn-green" onclick="openAddSubscriberPrompt()">+ Add Subscriber</button>
          <button class="btn btn-ghost" onclick="bulkConfirm()">Mark Confirmed</button>
          <button class="btn btn-danger" onclick="bulkUnsubscribe()">Unsubscribe Selected</button>
          <button class="btn btn-danger" onclick="bulkDelete()">Delete Permanently</button>
        </div>
        <div id="subscriber-list"><div class="empty">Loading…</div></div>
      </div>
    </div>

    <!-- ============ COMPOSE BROADCAST ============ -->
    <div class="panel" id="panel-compose">
      <div class="card">
        <h3>Compose a Custom Message</h3>
        <p class="sub">This goes out through the same protected system as automatic post notifications — your daily sending limit and quota-spillover protection apply here too, so nothing is ever skipped, just delivered over time if needed.</p>

        <label>Subject</label>
        <input type="text" id="bc-subject" placeholder="e.g. A special update from Liyog World Global">

        <label>Message Body (you can use basic HTML, e.g. &lt;a href="..."&gt;link text&lt;/a&gt;)</label>
        <textarea id="bc-body" placeholder="Write your message here..."></textarea>

        <label>Image URL (optional)</label>
        <input type="url" id="bc-image" placeholder="https://...">

        <label>Button Link (optional — sends readers back to the blog or anywhere else)</label>
        <input type="url" id="bc-cta-link" placeholder="https://www.liyogworld.com.ng/...">

        <label>Button Label</label>
        <input type="text" id="bc-cta-label" placeholder="e.g. Read the Full Story">

        <label>Send To</label>
        <select id="bc-target">
          <option value="all_confirmed">All Confirmed Subscribers</option>
          <option value="all_unconfirmed">All Unconfirmed Subscribers</option>
          <option value="everyone">Everyone (Confirmed + Unconfirmed)</option>
          <option value="selected">Selected Subscribers (choose below)</option>
        </select>

        <div id="bc-selected-wrap" style="display:none;">
          <label>Choose Recipients</label>
          <div class="toolbar"><input type="text" id="bc-sub-search" placeholder="Search subscribers to select…"></div>
          <div id="bc-subscriber-picker" class="preview-box"><div class="empty">Loading…</div></div>
        </div>

        <div class="toolbar" style="margin-top:18px;">
          <button class="btn btn-gold" onclick="sendBroadcast()">Send Broadcast</button>
        </div>
      </div>
    </div>

    <!-- ============ SEND LOGS ============ -->
    <div class="panel" id="panel-logs">
      <div class="card">
        <h3>Recent Send Activity</h3>
        <div id="send-log-table"><div class="empty">Loading…</div></div>
      </div>
    </div>

    <!-- ============ SYSTEM HEALTH ============ -->
    <div class="panel" id="panel-system">
      <div class="card">
        <h3>Manual Worker Controls</h3>
        <p class="sub">Force any of these to run right now instead of waiting for their normal hourly schedule.</p>
        <div class="toolbar">
          <button class="btn btn-green" onclick="runWorkerAction('run-check')">Check for New Post Now</button>
          <button class="btn btn-ghost" onclick="runWorkerAction('drain')">Drain Pending Emails Now</button>
        </div>
        <div id="worker-action-result"></div>
      </div>
      <div class="card">
        <h3>Live System Snapshot</h3>
        <div id="system-snapshot"><div class="empty">Loading…</div></div>
      </div>
    </div>

    <!-- ============ SETTINGS ============ -->
    <div class="panel" id="panel-settings">
      <div class="card">
        <h3>Account Recovery</h3>
        <p class="sub">Set a recovery code now so you can reset your password later if you ever forget it, without needing anyone to manually edit the database. Store this code somewhere safe — treat it like a spare key.</p>
        <label>New Recovery Code</label>
        <input type="text" id="recovery-code-input" placeholder="Choose a recovery code, at least 8 characters">
        <button class="btn btn-green" onclick="saveRecoveryCode()">Save Recovery Code</button>
      </div>
    </div>

  </div>

  <div class="toast" id="toast"></div>

<script>
function toast(msg, type){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || 'success');
  setTimeout(()=> t.className = 'toast', 2800);
}

function escapeHtml(s){
  if(!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------- Tab switching ----------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'overview') loadOverview();
    if (tab.dataset.tab === 'subscribers') loadSubscribers();
    if (tab.dataset.tab === 'compose') loadComposeSubscriberPicker();
    if (tab.dataset.tab === 'logs') loadLogs();
    if (tab.dataset.tab === 'system') loadSystemSnapshot();
  });
});

async function api(path, opts){
  const res = await fetch('/api' + path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { window.location.href = '/login'; return null; }
  return res.json();
}

function logout(){
  fetch('/logout', { method: 'POST', credentials: 'same-origin' }).then(()=> window.location.href = '/login');
}

// ---------- Overview ----------
async function loadOverview(){
  const data = await api('/overview');
  if (!data) return;
  const cards = document.querySelectorAll('#overview-stats .stat-card');
  cards[0].querySelector('.num').textContent = data.subscribers.confirmed;
  cards[1].querySelector('.num').textContent = data.subscribers.unconfirmed;
  cards[2].querySelector('.num').textContent = data.quota.sentToday + ' / ' + data.quota.dailyLimit;
  cards[3].querySelector('.num').textContent = data.spillover.pendingCount;
  if (data.spillover.pendingCount > 0) cards[3].classList.add('warn');

  const list = document.getElementById('recent-broadcasts');
  if (data.recentBroadcasts.length === 0) {
    list.innerHTML = '<div class="empty">No custom broadcasts sent yet.</div>';
  } else {
    list.innerHTML = '<table><tr><th>Subject</th><th>Target</th><th>Recipients</th><th>Status</th><th>Date</th></tr>' +
      data.recentBroadcasts.map(b => \`<tr><td>\${escapeHtml(b.subject)}</td><td>\${b.target_type}</td><td>\${b.total_recipients}</td><td>\${b.status}</td><td>\${b.created_at}</td></tr>\`).join('') +
      '</table>';
  }
}

// ---------- Subscribers ----------
let currentFilter = 'all';
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.filter;
    loadSubscribers();
  });
});
document.getElementById('sub-search').addEventListener('input', () => loadSubscribers());

async function loadSubscribers(){
  const query = document.getElementById('sub-search').value;
  const data = await api('/subscribers?query=' + encodeURIComponent(query) + '&filter=' + currentFilter);
  if (!data) return;
  const list = document.getElementById('subscriber-list');
  if (data.subscribers.length === 0) {
    list.innerHTML = '<div class="empty">No subscribers match.</div>';
    return;
  }
  list.innerHTML = data.subscribers.map(s => \`
    <div class="sub-row">
      <input type="checkbox" class="sub-checkbox" value="\${escapeHtml(s.email)}">
      <span class="email">\${escapeHtml(s.email)}</span>
      <span class="status-pill status-\${s.confirmed ? 'confirmed' : 'unconfirmed'}">\${s.confirmed ? 'Confirmed' : 'Unconfirmed'}</span>
    </div>\`).join('');
}

function getSelectedSubscriberEmails(){
  return Array.from(document.querySelectorAll('.sub-checkbox:checked')).map(cb => cb.value);
}

async function bulkUnsubscribe(){
  const emails = getSelectedSubscriberEmails();
  if (emails.length === 0) { toast('Select at least one subscriber first', 'error'); return; }
  if (!confirm('Unsubscribe ' + emails.length + ' subscriber(s)? They will stop receiving all future emails.')) return;
  const result = await api('/subscribers/unsubscribe', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ emails }) });
  if (result && result.success) { toast(result.updated + ' subscriber(s) unsubscribed'); loadSubscribers(); }
}

async function bulkDelete(){
  const emails = getSelectedSubscriberEmails();
  if (emails.length === 0) { toast('Select at least one subscriber first', 'error'); return; }
  if (!confirm('PERMANENTLY DELETE ' + emails.length + ' subscriber(s)? This cannot be undone — their record will be completely removed, not just unsubscribed.')) return;
  const result = await api('/subscribers/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ emails }) });
  if (result && result.success) { toast(result.deleted + ' subscriber(s) permanently deleted'); loadSubscribers(); }
}

async function saveRecoveryCode(){
  const code = document.getElementById('recovery-code-input').value.trim();
  if (code.length < 8) { toast('Recovery code must be at least 8 characters', 'error'); return; }
  const result = await api('/account/set-recovery-code', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ recoveryCode: code }) });
  if (result && result.success) { toast('Recovery code saved'); document.getElementById('recovery-code-input').value = ''; }
  else { toast(result && result.error ? result.error : 'Failed to save', 'error'); }
}

async function bulkConfirm(){
  const emails = getSelectedSubscriberEmails();
  if (emails.length === 0) { toast('Select at least one subscriber first', 'error'); return; }
  const result = await api('/subscribers/confirm', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ emails }) });
  if (result && result.success) { toast(result.updated + ' subscriber(s) marked confirmed'); loadSubscribers(); }
}

function openAddSubscriberPrompt(){
  const email = prompt('Enter the email address to add as a confirmed subscriber (no confirmation email will be sent):');
  if (!email) return;
  api('/subscribers/add', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email }) })
    .then(result => { if (result && result.success) { toast('Subscriber added'); loadSubscribers(); } });
}

// ---------- Compose Broadcast ----------
document.getElementById('bc-target').addEventListener('change', (e) => {
  document.getElementById('bc-selected-wrap').style.display = e.target.value === 'selected' ? 'block' : 'none';
});

async function loadComposeSubscriberPicker(){
  const data = await api('/subscribers?query=&filter=all');
  if (!data) return;
  renderComposePicker(data.subscribers);
}
document.getElementById('bc-sub-search')?.addEventListener('input', async (e) => {
  const data = await api('/subscribers?query=' + encodeURIComponent(e.target.value) + '&filter=all');
  if (data) renderComposePicker(data.subscribers);
});
function renderComposePicker(subscribers){
  const wrap = document.getElementById('bc-subscriber-picker');
  if (subscribers.length === 0) { wrap.innerHTML = '<div class="empty">No matches.</div>'; return; }
  wrap.innerHTML = subscribers.map(s => \`
    <div class="sub-row">
      <input type="checkbox" class="bc-sub-checkbox" value="\${escapeHtml(s.email)}">
      <span class="email">\${escapeHtml(s.email)}</span>
    </div>\`).join('');
}

async function sendBroadcast(){
  const subject = document.getElementById('bc-subject').value.trim();
  const body = document.getElementById('bc-body').value.trim();
  const image = document.getElementById('bc-image').value.trim();
  const ctaLink = document.getElementById('bc-cta-link').value.trim();
  const ctaLabel = document.getElementById('bc-cta-label').value.trim();
  const target = document.getElementById('bc-target').value;

  if (!subject || !body) { toast('Subject and message body are required', 'error'); return; }

  let targetEmails = null;
  if (target === 'selected') {
    targetEmails = Array.from(document.querySelectorAll('.bc-sub-checkbox:checked')).map(cb => cb.value);
    if (targetEmails.length === 0) { toast('Select at least one recipient', 'error'); return; }
  }

  if (!confirm('Send this broadcast now? This cannot be undone.')) return;

  const result = await api('/broadcast/send', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ subject, body, image, ctaLink, ctaLabel, target, targetEmails })
  });
  if (result && result.success) {
    toast('Broadcast queued for ' + result.recipientCount + ' recipient(s)');
    document.getElementById('bc-subject').value = '';
    document.getElementById('bc-body').value = '';
    document.getElementById('bc-image').value = '';
    document.getElementById('bc-cta-link').value = '';
    document.getElementById('bc-cta-label').value = '';
  } else if (result) {
    toast(result.error || 'Something went wrong', 'error');
  }
}

// ---------- Send Logs ----------
async function loadLogs(){
  const data = await api('/logs');
  if (!data) return;
  const wrap = document.getElementById('send-log-table');
  if (data.logs.length === 0) { wrap.innerHTML = '<div class="empty">No send activity yet.</div>'; return; }
  wrap.innerHTML = '<table><tr><th>Recipient</th><th>Type</th><th>Status</th><th>Date</th></tr>' +
    data.logs.map(l => \`<tr><td>\${escapeHtml(l.recipient)}</td><td>\${l.email_type}</td><td><span class="status-pill status-\${l.status}">\${l.status}</span></td><td>\${l.created_at}</td></tr>\`).join('') +
    '</table>';
}

// ---------- System Health ----------
async function loadSystemSnapshot(){
  const data = await api('/overview');
  if (!data) return;
  document.getElementById('system-snapshot').innerHTML = \`
    <p style="margin-bottom:10px;"><strong>Last feed check:</strong> \${data.feed.lastCheckedAt || 'Never run yet'}</p>
    <p style="margin-bottom:10px;"><strong>Last detected post ID:</strong> \${data.feed.lastDetectedPostId || 'None yet'}</p>
    <p style="margin-bottom:10px;"><strong>Emails sent today:</strong> \${data.quota.sentToday} of \${data.quota.dailyLimit}</p>
    <p><strong>Pending spillover (waiting to be sent):</strong> \${data.spillover.pendingCount}</p>
  \`;
}

async function runWorkerAction(action){
  const resultBox = document.getElementById('worker-action-result');
  resultBox.innerHTML = '<p style="color:#888;">Running…</p>';
  const result = await api('/worker/' + action, { method: 'POST' });
  if (result && result.success) {
    resultBox.innerHTML = '<p style="color:#34BF49;">' + escapeHtml(result.message) + '</p>';
    toast('Action completed');
  } else {
    resultBox.innerHTML = '<p style="color:#FF3B30;">Action failed. Check Worker logs for details.</p>';
  }
}

// Initial load
loadOverview();
</script>
</body></html>`;
}
// ============================================================
// Main router — ties authentication, data layer, and the
// dashboard UI together into actual HTTP responses.
// ============================================================

async function handleLogin(request, env) {
  const formData = await request.formData();
  const username = (formData.get("username") || "").trim();
  const password = formData.get("password") || "";

  const user = await env.DB.prepare(
    "SELECT id, password_hash FROM admin_users WHERE username = ?"
  ).bind(username).first();

  if (!user) {
    return new Response(loginPageHtml("Invalid username or password."), {
      status: 401, headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  const hashedAttempt = await hashPassword(password);
  if (hashedAttempt !== user.password_hash) {
    return new Response(loginPageHtml("Invalid username or password."), {
      status: 401, headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  const token = await createSession(env, user.id);
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/",
      "Set-Cookie": `liyog_admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
    },
  });
}

async function handleLogout(request, env) {
  const token = getCookie(request, "liyog_admin_session");
  if (token) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
  }
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/login",
      "Set-Cookie": "liyog_admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleApiRequest(request, env, pathname, userId) {
  // ---------- GET /api/overview ----------
  if (pathname === "/api/overview" && request.method === "GET") {
    const overview = await getDashboardOverview(env);
    const recentBroadcasts = await getRecentAdminMessages(env, 10);
    return jsonResponse({ ...overview, recentBroadcasts });
  }

  // ---------- GET /api/subscribers?query=&filter= ----------
  if (pathname === "/api/subscribers" && request.method === "GET") {
    const url = new URL(request.url);
    const query = url.searchParams.get("query") || "";
    const filter = url.searchParams.get("filter") || "all";
    const subscribers = await searchSubscribers(env, { query, confirmedFilter: filter });
    return jsonResponse({ subscribers });
  }

  // ---------- POST /api/subscribers/unsubscribe ----------
  if (pathname === "/api/subscribers/unsubscribe" && request.method === "POST") {
    const body = await request.json();
    const updated = await setSubscriberConfirmed(env, body.emails || [], 0);
    return jsonResponse({ success: true, updated });
  }

  // ---------- POST /api/subscribers/confirm ----------
  if (pathname === "/api/subscribers/confirm" && request.method === "POST") {
    const body = await request.json();
    const updated = await setSubscriberConfirmed(env, body.emails || [], 1);
    return jsonResponse({ success: true, updated });
  }

  // ---------- POST /api/subscribers/delete ----------
  if (pathname === "/api/subscribers/delete" && request.method === "POST") {
    const body = await request.json();
    const deleted = await deleteSubscribersCompletely(env, body.emails || []);
    return jsonResponse({ success: true, deleted });
  }

  // ---------- POST /api/subscribers/add ----------
  if (pathname === "/api/subscribers/add" && request.method === "POST") {
    const body = await request.json();
    const email = (body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ success: false, error: "Invalid email address" }, 400);
    }
    const result = await addSubscriberDirectly(env, email);
    return jsonResponse({ success: true, ...result });
  }

  // ---------- POST /api/broadcast/send ----------
  if (pathname === "/api/broadcast/send" && request.method === "POST") {
    const body = await request.json();
    const { subject, body: bodyHtmlRaw, image, ctaLink, ctaLabel, target, targetEmails } = body;

    if (!subject || !bodyHtmlRaw) {
      return jsonResponse({ success: false, error: "Subject and message body are required." }, 400);
    }

    try {
      const messageId = await createAdminMessage(env, {
        subject,
        bodyHtml: bodyHtmlRaw.replace(/\n/g, "<br>"),
        imageUrl: image || null,
        ctaLink: ctaLink || null,
        ctaLabel: ctaLabel || null,
        targetType: target,
        targetEmails: target === "selected" ? targetEmails : null,
      });
      const result = await dispatchAdminBroadcast(env, messageId);
      return jsonResponse({ success: true, recipientCount: result.recipientCount });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 400);
    }
  }

  // ---------- GET /api/logs ----------
  if (pathname === "/api/logs" && request.method === "GET") {
    const logs = await getSendLog(env, 100);
    return jsonResponse({ logs });
  }

  // ---------- POST /api/worker/run-check ----------
  if (pathname === "/api/worker/run-check" && request.method === "POST") {
    try {
      const res = await env.FEED_CHECK_SERVICE.fetch(new Request("https://internal/run-check"));
      const text = await res.text();
      return jsonResponse({ success: res.ok, message: text });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---------- POST /api/worker/drain ----------
  if (pathname === "/api/worker/drain" && request.method === "POST") {
    try {
      const res = await env.EMAIL_SENDER_SERVICE.fetch(new Request("https://internal/drain"));
      const text = await res.text();
      return jsonResponse({ success: res.ok, message: text });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---------- POST /api/account/set-recovery-code ----------
  if (pathname === "/api/account/set-recovery-code" && request.method === "POST") {
    const body = await request.json();
    const code = (body.recoveryCode || "").trim();
    if (code.length < 8) {
      return jsonResponse({ success: false, error: "Recovery code must be at least 8 characters." }, 400);
    }
    await setRecoveryCode(env, userId, code);
    return jsonResponse({ success: true });
  }

  // ADDED: Fallback if an API route matches "/api/*" but isn't explicitly handled above
  return jsonResponse({ error: "API route not found" }, 404);
} // <--- ADDED: Properly closes handleApiRequest

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Serve the Forgot Password HTML page
    if (pathname === "/forgot-password" && request.method === "GET") {
      return new Response(forgotPasswordPageHtml(null), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    // 2. FIXED: Process the Forgot Password Form Submission
    if (pathname === "/forgot-password" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const username = (formData.get("username") || "").trim();
        const recoveryCode = formData.get("recoveryCode") || "";
        const newPassword = formData.get("newPassword") || "";

        if (!username || !recoveryCode || !newPassword) {
          return new Response(forgotPasswordPageHtml("All fields are required."), {
            status: 400, headers: { "Content-Type": "text/html; charset=UTF-8" }
          });
        }

        // Call your existing business logic function
        const result = await resetPasswordWithRecoveryCode(env, username, recoveryCode, newPassword);

        if (!result.success) {
          return new Response(forgotPasswordPageHtml(result.error), {
            status: 400, headers: { "Content-Type": "text/html; charset=UTF-8" }
          });
        }

        // Success! Redirect them to login with a clean slate
        return new Response(null, {
          status: 302,
          headers: { "Location": "/login" },
        });
      } catch (err) {
        return new Response(forgotPasswordPageHtml("An unexpected error occurred: " + err.message), {
          status: 500, headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }
    }

    // Login routes are always accessible, never behind auth
    if (pathname === "/login" && request.method === "GET") {
      return new Response(loginPageHtml(null), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }
    if (pathname === "/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (pathname === "/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }

    // Everything else requires a valid session
    const userId = await requireAuth(request, env);
    if (!userId) {
      if (pathname.startsWith("/api/")) return jsonResponse({ error: "Unauthorized" }, 401);
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    }

    if (pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, pathname, userId);
    }

    // Default: serve the dashboard itself
    return new Response(dashboardPageHtml(), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  },
};




