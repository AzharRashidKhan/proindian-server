require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= FIREBASE INIT ================= */

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ================= CACHE ================= */

let cache = {};
const CACHE_DURATION = 2 * 60 * 1000;

/* ================= FETCH NEWS ================= */

async function fetchNews() {
  try {
    console.log("Fetching news...");

    const response = await axios.get(
      "https://newsapi.org/v2/top-headlines",
      {
        params: {
          country: "in",
          pageSize: 10,
          apiKey: process.env.NEWS_API_KEY,
        },
      }
    );

    for (const article of response.data.articles) {
      if (!article.title || !article.url) continue;

      const duplicate = await db
        .collection("news")
        .where("title", "==", article.title)
        .get();

      if (!duplicate.empty) continue;

      await db.collection("news").add({
        title: article.title,
        summary: article.description || "",
        category: "India",
        source: article.source.name,
        sourceUrl: article.url,
        image: article.urlToImage || "",
        likes: 0,
        views: 0,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    console.log("News fetch completed.");
  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

/* ================= PAGINATED NEWS ================= */

app.get("/news", async (req, res) => {
  try {
    const { category, lastTimestamp } = req.query;
    const limit = 10;

    let query = db.collection("news").orderBy("timestamp", "desc");

    if (category && category !== "All" && category !== "Trending") {
      query = query.where("category", "==", category);
    }

    if (lastTimestamp) {
      query = query.startAfter(new Date(Number(lastTimestamp)));
    }

    const snapshot = await query.limit(limit).get();

    const news = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(news);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

/* ================= TRENDING (24 HOURS) ================= */

app.get("/news/trending", async (req, res) => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const snapshot = await db
      .collection("news")
      .where("timestamp", ">", yesterday)
      .get();

    let news = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    news = news.map(article => ({
      ...article,
      trendingScore:
        (article.likes || 0) * 4 +
        (article.views || 0) -
        ((Date.now() - new Date(article.timestamp).getTime()) / 10000000),
    }));

    news.sort((a, b) => b.trendingScore - a.trendingScore);

    res.json(news.slice(0, 20));
  } catch (err) {
    res.status(500).json({ error: "Trending failed" });
  }
});

/* ================= LIKE ================= */

app.post("/news/:id/like", async (req, res) => {
  try {
    await db.collection("news").doc(req.params.id).update({
      likes: admin.firestore.FieldValue.increment(1),
    });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Like failed" });
  }
});

/* ================= VIEW ================= */

app.post("/news/:id/view", async (req, res) => {
  try {
    await db.collection("news").doc(req.params.id).update({
      views: admin.firestore.FieldValue.increment(1),
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
  console.log(`Server running on port ${PORT}`);
});
