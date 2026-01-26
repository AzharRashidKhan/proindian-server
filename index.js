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
        category: "India", // can upgrade to AI categorization later
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
    const limit = parseInt(req.query.limit) || 10;
    const category = req.query.category;
    const lastTimestamp = req.query.lastTimestamp;

    let query = db.collection("news");

    if (category && category !== "All") {
      query = query.where("category", "==", category);
    }

    query = query.orderBy("timestamp", "desc").limit(limit);

    if (lastTimestamp) {
      const cursorDate = new Date(lastTimestamp);
      query = query.startAfter(cursorDate);
    }

    const snapshot = await query.get();

    const articles = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    let newLastTimestamp = null;

    if (articles.length > 0) {
      const last = articles[articles.length - 1].timestamp;
      if (last && last.toDate) {
        newLastTimestamp = last.toDate().toISOString();
      }
    }

    res.json({
      articles,
      lastTimestamp: newLastTimestamp,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pagination failed" });
  }
});

/* ================= TRENDING (SMART 24H DECAY) ================= */

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

    // 🔥 Smart time-decay formula
    news = news.map(article => {
      const likes = article.likes || 0;
      const views = article.views || 0;

      const ageHours =
        (Date.now() -
          (article.timestamp?.toDate
            ? article.timestamp.toDate().getTime()
            : Date.now())) /
        (1000 * 60 * 60);

      const score =
        (likes * 5 + views * 1) / Math.pow(ageHours + 2, 1.5);

      return {
        ...article,
        trendingScore: score,
      };
    });

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

/* ================= HEALTH CHECK ================= */

app.get("/", (req, res) => {
  res.send("ProIndian Server Running 🚀");
});

/* ================= CRON ================= */

cron.schedule("*/30 * * * *", fetchNews);
fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
