// Builds the "scrollable 3-4 posts" feed shown after a notification is tapped,
// or inside a bell-icon panel on the site/app. Mixes latest posts with an
// occasional high-engagement older post, the same way Facebook/news apps do,
// instead of always showing pure reverse-chronological.

export async function buildSmartFeed(db, limit = 4) {
  const latest = await db
    .prepare(
      `SELECT post_id, title, url, featured_image, excerpt, category, published_at
       FROM posts_cache
       ORDER BY published_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();

  const items = latest.results || [];

  // If we have room and there's a genuinely popular post from the last 14 days
  // that isn't already in the latest batch, swap it into the last slot.
  if (items.length === limit) {
    const popular = await db
      .prepare(
        `SELECT post_id, title, url, featured_image, excerpt, category, published_at
         FROM posts_cache
         WHERE published_at >= datetime('now', '-14 days')
           AND popularity_score > 0
         ORDER BY popularity_score DESC
         LIMIT 1`
      )
      .first();

    if (popular && !items.find((p) => p.post_id === popular.post_id)) {
      items[items.length - 1] = popular;
    }
  }

  return items;
}
