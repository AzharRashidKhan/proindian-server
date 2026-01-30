require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");
const rateLimit = require("express-rate-limit");
const axios = require("axios");

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

/* ================= RATE LIMIT ================= */

const interactionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
});

/* ================= CATEGORY MAP ================= */

function mapCategory(apiCategory) {
  if (!apiCategory) return "India";

  const cat = apiCategory.toLowerCase();

  if (cat.includes("business")) return "Business";
  if (cat.includes("sports")) return "Sports";
  if (cat.includes("health")) return "Health";
  if (cat.includes("technology")) return "Technology";
  if (cat.includes("world")) return "World";

  return "India";
}

/* ================= BREAKING LOGIC ================= */

function isBreaking(title, pubDate) {
  const lower = title.toLowerCase();
  const ageHours =
    (Date.now() - new Date(pubDate).getTime()) /
    (1000 * 60 * 60);

  return (
    ageHours < 2 &&
    (lower.includes("breaking") ||
      lower.includes("live") ||
      lower.includes("just in") ||
      lower.includes("alert"))
  );
}

/* ================= FETCH NEWS ================= */

async function fetchNews() {
  try {
    console.log("Fetching NewsData news...");

    const response = await axios.get(
      "https://newsdata.io/api/1/news",
      {
        params: {
          apikey: process.env.NEWSDATA_API_KEY,
          country: "in",
          language: "en",
        },
      }
    );

    const articles = response.data.results || [];

    for (const item of articles) {
      if (!item.title || !item.link) continue;

      const duplicate = await db
        .collection("news")
        .where("title", "==", item.title)
        .get();

      if (!duplicate.empty) continue;

      const category = mapCategory(
        item.category ? item.category[0] : ""
      );

      const breaking = isBreaking(item.title, item.pubDate);

      await db.collection("news").add({
        title: item.title,
        summary: item.description || "",
        category,
        source: item.source_id || "News",
        sourceUrl: item.link,
        image: item.image_url || "",
        breaking,
        likes: 0,
        views: 0,
        likedBy: [],
        viewedBy: [],
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    console.log("Fetch completed.");
  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

/* ================= DELETE OLD NEWS ================= */

async function deleteOldNews() {
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  );

  const snapshot = await db
    .collection("news")
    .where("timestamp", "<", sevenDaysAgo)
    .get();

  const batch = db.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  console.log("Old news deleted:", snapshot.size);
}

/* ================= PAGINATION ================= */

app.get("/news", async (req, res) => {
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
});

/* ================= TRENDING ================= */

app.get("/news/trending", async (req, res) => {
  const snapshot = await db
    .collection("news")
    .orderBy("timestamp", "desc")
    .limit(100)
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

    const score =
      (likes * 4 + views * 1.5) /
        Math.pow(ageHours + 2, 1.5) +
      (article.breaking && ageHours < 3 ? 20 : 0);

    return { ...article, trendingScore: score };
  });

  news.sort((a, b) => b.trendingScore - a.trendingScore);

  res.json(news.slice(0, 20));
});

/* ================= CRON ================= */

cron.schedule("*/30 * * * *", fetchNews);
cron.schedule("0 3 * * *", deleteOldNews);

fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
