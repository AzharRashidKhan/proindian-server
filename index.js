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

    const articles = response.data.articles;

    for (const article of articles) {
      if (!article.title || !article.url) continue;

      const duplicate = await db
        .collection("news")
        .where("title", "==", article.title)
        .limit(1)
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
        timestamp: new Date(article.publishedAt || Date.now()),
      });

      console.log("Saved:", article.title);
    }

    console.log("News fetch completed.");
  } catch (error) {
    console.error("Fetch error:", error.message);
  }
}

/* ================= HEALTH CHECK ================= */

app.get("/", (req, res) => {
  res.send("ProIndian Server Running 🚀");
});

/* ================= ALL NEWS (PAGINATED) ================= */

app.get("/news", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const lastTimestamp = req.query.lastTimestamp;

    let query = db
      .collection("news")
      .orderBy("timestamp", "desc")
      .limit(limit);

    if (lastTimestamp) {
      query = db
        .collection("news")
        .orderBy("timestamp", "desc")
        .startAfter(new Date(parseInt(lastTimestamp) * 1000))
        .limit(limit);
    }

    const snapshot = await query.get();

    const news = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(news);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

/* ================= CATEGORY FILTER (PAGINATED) ================= */

app.get("/news/category/:category", async (req, res) => {
  try {
    const category = req.params.category;
    const limit = parseInt(req.query.limit) || 10;
    const lastTimestamp = req.query.lastTimestamp;

    let query = db
      .collection("news")
      .where("category", "==", category)
      .orderBy("timestamp", "desc")
      .limit(limit);

    if (lastTimestamp) {
      query = db
        .collection("news")
        .where("category", "==", category)
        .orderBy("timestamp", "desc")
        .startAfter(new Date(parseInt(lastTimestamp) * 1000))
        .limit(limit);
    }

    const snapshot = await query.get();

    const news = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(news);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch category news" });
  }
});

/* ================= 🔥 TRENDING (24 HOURS) ================= */

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

    // Trending Score
    news = news.map(article => ({
      ...article,
      trendingScore:
        (article.likes || 0) * 3 +
        (article.views || 0),
    }));

    news.sort((a, b) => b.trendingScore - a.trendingScore);

    res.json(news.slice(0, 20));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch trending news" });
  }
});

/* ================= LIKE SYSTEM ================= */

app.post("/news/:id/like", async (req, res) => {
  try {
    const id = req.params.id;

    await db.collection("news").doc(id).update({
      likes: admin.firestore.FieldValue.increment(1),
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Like failed" });
  }
});

/* ================= VIEW TRACKING ================= */

app.post("/news/:id/view", async (req, res) => {
  try {
    const id = req.params.id;

    await db.collection("news").doc(id).update({
      views: admin.firestore.FieldValue.increment(1),
    });

    res.json({ success: true });
  } catch (err) {
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
