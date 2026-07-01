// Polls your Blogger JSON feed on a cron schedule and returns any posts
// not yet seen in posts_cache. This is what lets the system "pull" new
// blog posts automatically without you touching anything.

function extractFeaturedImage(entry) {
  if (entry.media$thumbnail?.url) {
    return entry.media$thumbnail.url.replace(/\/s\d+(-c)?\//, "/s1200/");
  }
  const html = entry.content?.$t || entry.summary?.$t || "";
  const match = html.match(/<img[^>]+src="([^"]+)"/i);
  return match ? match[1] : null;
}

function extractExcerpt(entry) {
  const html = entry.summary?.$t || entry.content?.$t || "";
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= 160) return text;

  // Break at a clean sentence boundary for a genuine hook
  const chunk = text.slice(0, 160);
  const sentenceEnd = chunk.search(/[.!?][^.!?]*$/);
  if (sentenceEnd > 60) return chunk.slice(0, sentenceEnd + 1).trim();

  // Fall back to word boundary
  const wordEnd = chunk.lastIndexOf(" ");
  return (wordEnd > 60 ? chunk.slice(0, wordEnd) : chunk).trim() + "\u2026";
}

function extractUrl(entry) {
  const links = entry.link || [];
  const alternate = links.find((l) => l.rel === "alternate" && l.href);
  if (alternate) return alternate.href;
  const anyLink = links.find((l) => l.href);
  if (anyLink) return anyLink.href;
  return null;
}

export async function fetchNewBloggerPosts(db, feedUrl) {
  const res = await fetch(feedUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Blogger feed fetch failed: ${res.status}`);
  const data = await res.json();

  const entries = data.feed?.entry || [];
  const newPosts = [];

  for (const entry of entries) {
    const postId = entry.id?.$t?.split("post-").pop();
    if (!postId) continue;

    const existing = await db
      .prepare(`SELECT id FROM posts_cache WHERE post_id = ?`)
      .bind(postId)
      .first();
    if (existing) continue;

    const category = (entry.category || [])[0]?.term || null;

    newPosts.push({
      postId,
      title: entry.title?.$t || "New post",
      url: extractUrl(entry),
      featuredImage: extractFeaturedImage(entry),
      excerpt: extractExcerpt(entry),
      category,
      publishedAt: entry.published?.$t || new Date().toISOString(),
    });
  }

  return newPosts;
}
