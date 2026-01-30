require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");
const rateLimit = require("express-rate-limit");
const Parser = require("rss-parser");

const parser = new Parser();
const app = express();

app.use(cors());
app.use(express.json());

/* ================= SAFE FIREBASE INIT ================= */

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

/* ================= CATEGORY DETECTION (KEYWORDS) ================= */

function detectCategoryFromKeywords(text) {
  const lower = text.toLowerCase();

  if (lower.match(/india|delhi|mumbai|modi|government|parliament/))
    return "India";

  if (lower.match(/usa|china|russia|uk|europe|world|international/))
    return "World";

  if (lower.match(/market|stock|rupee|economy|business|startup|finance/))
    return "Business";

  if (lower.match(/cricket|football|match|ipl|sports|tournament/))
    return "Sports";

  if (lower.match(/health|hospital|disease|covid|medical|doctor/))
    return "Health";

  if (lower.match(/ai|technology|tech|mobile|app|software|internet/))
    return "Technology";

  return "India";
}

/* ================= DEVICE REGISTER ================= */

app.post("/register-device", async (req, res) => {
  try {
    const { token, categories, platform } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    await db.collection("devices").doc(token).set({
      token,
      categories: categories || [],
      platform: platform || "web",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Device registration failed" });
  }
});

/* ================= FETCH NEWS FROM RSS ================= */

async function fetchNews() {
  try {
    console.log("Fetching RSS news...");

    const feeds = [
      "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
      "https://www.thehindu.com/news/national/feeder/default.rss",
      "https://feeds.bbci.co.uk/news/rss.xml",
    ];

    for (const feedUrl of feeds) {
      const feed = await parser.parseURL(feedUrl);
      

      for (const item of feed.items.slice(0, 10)) {
        if (!item.title || !item.link) continue;

        const duplicate = await db
          .collection("news")
          .where("title", "==", item.title)
          .get();

        if (!duplicate.empty) continue;

        const content =
          (item.contentSnippet || "") + " " + item.title;

        const category = detectCategoryFromKeywords(content);

        await db.collection("news").add({
          title: item.title,
          summary: item.contentSnippet || "",
          category,
          source: feed.title || "News",
          sourceUrl: item.link,
          image: item.enclosure?.url || "",
          likes: 0,
          views: 0,
          likedBy: [],
          viewedBy: [],
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    console.log("RSS fetch completed.");
  } catch (err) {
    console.error("RSS fetch error:", err.message);
  }
}

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

    const snapshot = await query.get();

    const articles = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    let newCursor = null;

    if (articles.length > 0) {
      const last = articles[articles.length - 1].timestamp;
      if (last?.toDate) {
        newCursor = last.toDate().toISOString();
      }
    }

    res.json({ articles, lastTimestamp: newCursor });
  } catch {
    res.status(500).json({ error: "Pagination failed" });
  }
});

/* ================= TRENDING ================= */

app.get("/news/trending", async (req, res) => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const snapshot = await db
      .collection("news")
      .where("timestamp", ">", yesterday)
      .get();

    let news = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    news = news.map((article) => {
      const likes = article.likes || 0;
      const views = article.views || 0;

      const ageHours =
        (Date.now() -
          (article.timestamp?.toDate
            ? article.timestamp.toDate().getTime()
            : Date.now())) /
        (1000 * 60 * 60);

      const freshnessBoost = Math.max(24 - ageHours, 0);

      const score = freshnessBoost * 5 + likes * 3 + views;

      return { ...article, trendingScore: score };
    });

    news.sort((a, b) => b.trendingScore - a.trendingScore);

    res.json(news.slice(0, 20));
  } catch {
    res.status(500).json({ error: "Trending failed" });
  }
});

/* ================= LIKE ================= */

app.post("/news/:id/like", interactionLimiter, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId)
      return res.status(400).json({ error: "Device ID required" });

    const docRef = db.collection("news").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists)
      return res.status(404).json({ error: "Not found" });

    const data = doc.data();
    const likedBy = data.likedBy || [];

    if (likedBy.includes(deviceId)) {
      return res.json({ success: false, message: "Already liked" });
    }

    await docRef.update({
      likes: admin.firestore.FieldValue.increment(1),
      likedBy: admin.firestore.FieldValue.arrayUnion(deviceId),
    });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Like failed" });
  }
});

/* ================= VIEW ================= */

app.post("/news/:id/view", interactionLimiter, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId)
      return res.status(400).json({ error: "Device ID required" });

    const docRef = db.collection("news").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists)
      return res.status(404).json({ error: "Not found" });

    const data = doc.data();
    const viewedBy = data.viewedBy || [];

    if (viewedBy.includes(deviceId)) {
      return res.json({ success: false });
    }

    await docRef.update({
      views: admin.firestore.FieldValue.increment(1),
      viewedBy: admin.firestore.FieldValue.arrayUnion(deviceId),
    });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "View failed" });
  }
});

/* ================= CRON ================= */

cron.schedule("*/30 * * * *", fetchNews);
fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
