require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");
const rateLimit = require("express-rate-limit");
const Parser = require("rss-parser");
const axios = require("axios");

const parser = new Parser();
const app = express();

app.use(cors());
app.use(express.json());

/* ================= FIREBASE INIT ================= */

if (
  !process.env.FIREBASE_PROJECT_ID ||
  !process.env.FIREBASE_CLIENT_EMAIL ||
  !process.env.FIREBASE_PRIVATE_KEY
) {
  console.error("❌ Missing Firebase environment variables");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ================= RATE LIMIT ================= */

const interactionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ================= CATEGORY RSS FEEDS ================= */

const feeds = {
  India: [
    "https://www.thehindu.com/news/national/feeder/default.rss",
    "https://www.ndtv.com/rss/india",
    "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml",
    "https://indianexpress.com/section/india/rss/",
    "https://www.thequint.com/feed/india",
  ],
  World: [
    "https://www.thehindu.com/news/international/feeder/default.rss",
    "https://www.ndtv.com/rss/world",
    "https://indianexpress.com/section/world/rss/",
    "https://www.thequint.com/feed/world",
  ],
  Business: [
    "https://www.thehindu.com/business/feeder/default.rss",
    "https://www.ndtv.com/rss/business",
    "https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml",
    "https://indianexpress.com/section/business/rss/",
    "https://www.thequint.com/feed/business",
  ],
  Sports: [
    "https://www.thehindu.com/sport/feeder/default.rss",
    "https://www.ndtv.com/rss/sports",
    "https://www.hindustantimes.com/feeds/rss/sports/rssfeed.xml",
    "https://indianexpress.com/section/sports/rss/",
    "https://www.thequint.com/feed/sports",
  ],
  Health: [
    "https://www.thehindu.com/sci-tech/health/feeder/default.rss",
    "https://www.ndtv.com/rss/health",
    "https://www.hindustantimes.com/feeds/rss/lifestyle/health/rssfeed.xml",
  ],
  Technology: [
    "https://www.thehindu.com/sci-tech/technology/feeder/default.rss",
    "https://www.ndtv.com/rss/technology",
    "https://indianexpress.com/section/technology/rss/",
    "https://www.thequint.com/feed/tech-and-auto",
  ],
};

/* ================= BREAKING LOGIC ================= */

function isBreaking(title) {
  const t = title.toLowerCase();
  return (
    t.includes("breaking") ||
    t.includes("live") ||
    t.includes("just in") ||
    t.includes("alert")
  );
}

/* ================= TITLE SIMILARITY ================= */

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter(w => w.length > 3);
}

function similarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x));
  const union = new Set([...setA, ...setB]);
  return intersection.length / union.size;
}

/* ================= IMAGE EXTRACTION ================= */

async function extractImage(item) {
  if (item.enclosure?.url) return item.enclosure.url;
  if (item["media:content"]?.url) return item["media:content"].url;

  try {
    const res = await axios.get(item.link, { timeout: 5000 });
    const match = res.data.match(
      /<meta property="og:image" content="([^"]+)"/
    );
    if (match) return match[1];
  } catch {}

  return "";
}

/* ================= FETCH NEWS ================= */

async function fetchNews() {
  try {
    console.log("Fetching RSS news...");

    const hoursWindow = 6;
    const cutoff = new Date(Date.now() - hoursWindow * 3600000);

    const recentSnap = await db
      .collection("news")
      .where("timestamp", ">", cutoff)
      .get();

    const recent = recentSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    for (const category in feeds) {
      for (const feedUrl of feeds[category]) {
        try {
          const feed = await parser.parseURL(feedUrl);

          for (const item of feed.items.slice(0, 10)) {
            if (!item.title || !item.link) continue;

            const newWords = normalizeTitle(item.title);
            let duplicate = null;
            let highest = 0;

            for (const existing of recent) {
              const existingWords = normalizeTitle(existing.title);
              const score = similarity(newWords, existingWords);

              if (score > 0.65 && score > highest) {
                highest = score;
                duplicate = existing;
              }
            }

            const summary = item.contentSnippet || "";
            const image = await extractImage(item);
            const breaking = isBreaking(item.title);

            if (duplicate) {
              const docRef = db.collection("news").doc(duplicate.id);
              const updates = {};

              if (summary.length > (duplicate.summary || "").length)
                updates.summary = summary;

              if (!duplicate.image && image)
                updates.image = image;

              if (Object.keys(updates).length > 0)
                await docRef.update(updates);

              continue;
            }

            await db.collection("news").add({
              title: item.title,
              summary,
              category,
              source: feed.title || "News",
              sourceUrl: item.link,
              image,
              breaking,
              likes: 0,
              views: 0,
              likedBy: [],
              viewedBy: [],
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        } catch (err) {
          console.log("Feed error:", feedUrl);
        }
      }
    }

    console.log("RSS fetch completed.");
  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

/* ================= AUTO DELETE 7 DAYS ================= */

async function deleteOldNews() {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600000);

    const snap = await db
      .collection("news")
      .where("timestamp", "<", cutoff)
      .get();

    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    console.log("Deleted old news:", snap.size);
  } catch (err) {
    console.error("Delete error:", err.message);
  }
}

/* ================= TRENDING ================= */

app.get("/news/trending", async (req, res) => {
  try {
    const snap = await db
      .collection("news")
      .orderBy("timestamp", "desc")
      .limit(100)
      .get();

    let news = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    news = news.map(article => {
      const likes = article.likes || 0;
      const views = article.views || 0;

      const ageHours =
        (Date.now() -
          (article.timestamp?.toDate
            ? article.timestamp.toDate().getTime()
            : Date.now())) /
        3600000;

      const decay =
        (likes * 4 + views * 1.5) /
        Math.pow(ageHours + 2, 1.5);

      const breakingBoost =
        article.breaking && ageHours < 3 ? 20 : 0;

      return {
        ...article,
        trendingScore: decay + breakingBoost,
      };
    });

    news.sort((a, b) => b.trendingScore - a.trendingScore);

    res.json(news.slice(0, 20));
  } catch {
    res.status(500).json({ error: "Trending failed" });
  }
});

/* ================= PAGINATED NEWS ================= */

app.get("/news", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const category = req.query.category;
    const lastTimestamp = req.query.lastTimestamp;

    let query = db.collection("news");

    if (category && category !== "All") {
      query = query.where("category", "==", category);
    }

    query = query.orderBy("timestamp", "desc").limit(limit);

    if (lastTimestamp) {
      query = query.startAfter(new Date(lastTimestamp));
    }

    const snap = await query.get();

    const articles = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    let cursor = null;

    if (articles.length > 0) {
      const last = articles[articles.length - 1].timestamp;
      if (last?.toDate)
        cursor = last.toDate().toISOString();
    }

    res.json({ articles, lastTimestamp: cursor });
  } catch {
    res.status(500).json({ error: "Pagination failed" });
  }
});

/* ================= CRON ================= */

cron.schedule("*/30 * * * *", fetchNews);
cron.schedule("0 3 * * *", deleteOldNews);

fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
