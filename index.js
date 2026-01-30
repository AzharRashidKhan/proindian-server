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

if (
  !process.env.FIREBASE_PROJECT_ID ||
  !process.env.FIREBASE_CLIENT_EMAIL ||
  !process.env.FIREBASE_PRIVATE_KEY
) {
  console.error("Missing Firebase environment variables");
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

/* ================= CATEGORY MAP ================= */

function mapCategory(apiCategory) {
  if (!apiCategory) return "India";

  const cat = apiCategory.toLowerCase();

  if (cat.includes("business")) return "Business";
  if (cat.includes("sports")) return "Sports";
  if (cat.includes("technology")) return "Technology";
  if (cat.includes("health")) return "Health";
  if (cat.includes("world")) return "World";

  return "India";
}

/* ================= BREAKING LOGIC ================= */

function isBreaking(title) {
  const lower = title.toLowerCase();
  return (
    lower.includes("breaking") ||
    lower.includes("live") ||
    lower.includes("just in") ||
    lower.includes("alert")
  );
}

/* ================= DUPLICATE CHECK ================= */

async function isDuplicate(title) {
  const snapshot = await db
    .collection("news")
    .where("title", "==", title)
    .limit(1)
    .get();

  return !snapshot.empty;
}

/* ================= FETCH NEWS FROM NEWSDATA ================= */

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
          category:
            "business,technology,health,world,sports",
          image: 1, // only articles with images
        },
      }
    );

    const articles = response.data.results || [];

    for (const article of articles) {
      if (!article.title || !article.link) continue;

      const duplicate = await isDuplicate(article.title);
      if (duplicate) continue;

      await db.collection("news").add({
        title: article.title,
        summary: article.description || "",
        category: mapCategory(
          article.category?.[0]
        ),
        source: article.source_id || "News",
        sourceUrl: article.link,
        image: article.image_url || "",
        breaking: isBreaking(article.title),
        likes: 0,
        views: 0,
        likedBy: [],
        viewedBy: [],
        timestamp:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    console.log("Fetch completed.");
  } catch (err) {
    console.error(
      "Fetch error:",
      err.response?.data || err.message
    );
  }
}

/* ================= AUTO DELETE (7 DAYS) ================= */

async function deleteOldNews() {
  try {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    );

    const snapshot = await db
      .collection("news")
      .where("timestamp", "<", sevenDaysAgo)
      .get();

    const batch = db.batch();
    snapshot.docs.forEach((doc) =>
      batch.delete(doc.ref)
    );
    await batch.commit();

    console.log("Old news deleted:", snapshot.size);
  } catch (err) {
    console.error("Delete error:", err.message);
  }
}

/* ================= TRENDING ================= */

app.get("/news/trending", async (req, res) => {
  try {
    const snapshot = await db
      .collection("news")
      .orderBy("timestamp", "desc")
      .limit(100)
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
            ? article.timestamp
                .toDate()
                .getTime()
            : Date.now())) /
        (1000 * 60 * 60);

      const decay =
        (likes * 4 + views * 1.5) /
        Math.pow(ageHours + 2, 1.4);

      const breakingBoost =
        article.breaking && ageHours < 3
          ? 20
          : 0;

      return {
        ...article,
        trendingScore: decay + breakingBoost,
      };
    });

    news.sort(
      (a, b) => b.trendingScore - a.trendingScore
    );

    res.json(news.slice(0, 20));
  } catch {
    res
      .status(500)
      .json({ error: "Trending failed" });
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
      query = query.where(
        "category",
        "==",
        category
      );
    }

    query = query
      .orderBy("timestamp", "desc")
      .limit(limit);

    if (lastTimestamp) {
      query = query.startAfter(
        new Date(lastTimestamp)
      );
    }

    const snapshot = await query.get();

    const articles = snapshot.docs.map(
      (doc) => ({
        id: doc.id,
        ...doc.data(),
      })
    );

    let newCursor = null;

    if (articles.length > 0) {
      const last =
        articles[articles.length - 1]
          .timestamp;
      if (last?.toDate) {
        newCursor = last
          .toDate()
          .toISOString();
      }
    }

    res.json({
      articles,
      lastTimestamp: newCursor,
    });
  } catch {
    res
      .status(500)
      .json({ error: "Pagination failed" });
  }
});

/* ================= CRON ================= */

cron.schedule("*/30 * * * *", fetchNews);
cron.schedule("0 3 * * *", deleteOldNews);

fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
