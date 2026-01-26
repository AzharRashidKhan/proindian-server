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

/* ================= AI CATEGORY DETECTION ================= */

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
Classify this news into ONE category only:
India, World, Business, Sports, Health, Technology

Return only the category word.

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
          "Content-Type": "application/json",
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
  } catch {
    res.status(500).json({ error: "Pagination failed" });
  }
});

/* ================= INSHORTS-STYLE TRENDING ================= */

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

      // Fresh-first formula like real apps
      const freshnessBoost = Math.max(24 - ageHours, 0);

      const score =
        freshnessBoost * 5 +
        likes * 3 +
        views * 1;

      return { ...article, trendingScore: score };
    });

    news.sort((a, b) => b.trendingScore - a.trendingScore);

    res.json(news.slice(0, 20));
  } catch {
    res.status(500).json({ error: "Trending failed" });
  }
});

/* ================= LIKE WITH DUPLICATE PROTECTION ================= */

app.post("/news/:id/like", async (req, res) => {
  try {
    const { userId } = req.body;
    const docRef = db.collection("news").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ error: "Not found" });

    const data = doc.data();

    if (data.likedBy.includes(userId)) {
      return res.json({ success: false, message: "Already liked" });
    }

    await docRef.update({
      likes: admin.firestore.FieldValue.increment(1),
      likedBy: admin.firestore.FieldValue.arrayUnion(userId),
    });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Like failed" });
  }
});

/* ================= VIEW TRACKING ================= */

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
