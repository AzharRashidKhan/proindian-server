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

if (
  !process.env.FIREBASE_PROJECT_ID ||
  !process.env.FIREBASE_CLIENT_EMAIL ||
  !process.env.FIREBASE_PRIVATE_KEY
) {
  console.error("Missing Firebase env variables");
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
});

/* ================= CLEAN + TRIM SUMMARY ================= */

function cleanAndTrimSummary(text, maxWords = 100) {
  if (!text) return "";

  let cleaned = text.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/\.\.\.+$/, "");

  const words = cleaned.split(" ");
  if (words.length <= maxWords) return cleaned;

  const trimmed = words.slice(0, maxWords).join(" ");

  const lastPeriod = trimmed.lastIndexOf(".");
  if (lastPeriod > 60) {
    return trimmed.slice(0, lastPeriod + 1);
  }

  return trimmed + ".";
}

/* ================= CATEGORY MAPPING ================= */

function mapCategory(newsDataCategory) {
  if (!newsDataCategory) return "India";

  const cat = newsDataCategory.toLowerCase();

  if (cat.includes("world")) return "World";
  if (cat.includes("business")) return "Business";
  if (cat.includes("sports")) return "Sports";
  if (cat.includes("technology")) return "Technology";
  if (cat.includes("health")) return "Health";

  return "India";
}

/* ================= BREAKING LOGIC ================= */

function isBreaking(title) {
  const t = title.toLowerCase();
  return (
    t.includes("breaking") ||
    t.includes("live") ||
    t.includes("alert") ||
    t.includes("just in")
  );
}

/* ================= DUPLICATE DETECTION ================= */

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter((w) => w.length > 3);
}

function similarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((w) => setB.has(w));
  const union = new Set([...setA, ...setB]);
  return intersection.length / union.size;
}

/* ================= FETCH FROM NEWSDATA ================= */

async function fetchNews() {
  try {
    console.log("Fetching NewsData news...");

    const response = await axios.get(
      "https://newsdata.io/api/1/news",
      {
        params: {
          apikey: process.env.NEWS_DATA_API_KEY,
          country: "in",
          language: "en",
          category: "top,world,business,sports,technology,health",
        },
      }
    );

    const articles = response.data.results || [];

    const hoursWindow = 6;
    const cutoff = new Date(Date.now() - hoursWindow * 60 * 60 * 1000);

    const recentSnapshot = await db
      .collection("news")
      .where("timestamp", ">", cutoff)
      .get();

    const recent = recentSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    for (const item of articles) {
      if (!item.title || !item.link) continue;

      const newWords = normalizeTitle(item.title);
      let duplicateDoc = null;
      let highestSim = 0;

      for (const existing of recent) {
        const existingWords = normalizeTitle(existing.title);
        const sim = similarity(newWords, existingWords);

        if (sim > 0.65 && sim > highestSim) {
          highestSim = sim;
          duplicateDoc = existing;
        }
      }

      const summary = cleanAndTrimSummary(item.description, 100);
      const image = item.image_url || "";
      const category = mapCategory(item.category?.[0]);
      const breaking = isBreaking(item.title);

      if (duplicateDoc) {
        const docRef = db.collection("news").doc(duplicateDoc.id);
        const update = {};

        if (summary.length > (duplicateDoc.summary || "").length) {
          update.summary = summary;
        }

        if (!duplicateDoc.image && image) {
          update.image = image;
        }

        if (Object.keys(update).length > 0) {
          await docRef.update(update);
        }

        continue;
      }

      await db.collection("news").add({
        title: item.title,
        summary,
        category,
        source: item.source_id || "News",
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

    console.log("Fetch completed.");
  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

/* ================= AUTO DELETE AFTER 7 DAYS ================= */

async function deleteOldNews() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const snapshot = await db
    .collection("news")
    .where("timestamp", "<", sevenDaysAgo)
    .get();

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  console.log("Deleted old news:", snapshot.size);
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
            ? article.timestamp.toDate().getTime()
            : Date.now())) /
        (1000 * 60 * 60);

      const decayScore =
        (likes * 4 + views * 1.5) /
        Math.pow(ageHours + 2, 1.5);

      const breakingBoost =
        article.breaking && ageHours < 3 ? 20 : 0;

      return {
        ...article,
        trendingScore: decayScore + breakingBoost,
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

/* ================= CRON ================= */

cron.schedule("*/30 * * * *", fetchNews);
cron.schedule("0 3 * * *", deleteOldNews);

fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
