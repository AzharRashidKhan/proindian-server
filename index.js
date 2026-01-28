require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");
const rateLimit = require("express-rate-limit");

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

/* ================= RATE LIMITING ================= */

const interactionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ================= AI CATEGORY ================= */

async function detectCategory(text) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "user",
            content: `
Classify into ONE:
India, World, Business, Sports, Health, Technology

Return only the word.

News:
${text}
`,
          },
        ],
        temperature: 0,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch {
    return "India";
  }
}

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

      const category = await detectCategory(
        article.description || article.title
      );

      await db.collection("news").add({
        title: article.title,
        summary: article.description || "",
        category,
        source: article.source.name,
        sourceUrl: article.url,
        image: article.urlToImage || "",
        likes: 0,
        views: 0,
        likedBy: [],
        viewedBy: [],
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
      query = query.startAfter(new Date(lastTimestamp));
    }

    const snapshot = await query.get();

    const articles = snapshot.docs.map(doc => ({
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
  } catch (err) {
    res.status(500).json({ error: "Pagination failed" });
  }
});

/* ================= SMART TRENDING ================= */

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

    news = news.map(article => {
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

/* ================= LIKE (DEVICE PROTECTED) ================= */

app.post("/news/:id/like", interactionLimiter, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "Device ID required" });

    const docRef = db.collection("news").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ error: "Not found" });

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

/* ================= VIEW (DEVICE PROTECTED) ================= */

app.post("/news/:id/view", interactionLimiter, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "Device ID required" });

    const docRef = db.collection("news").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ error: "Not found" });

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
  console.log(`Server running on port ${PORT}`);
});
