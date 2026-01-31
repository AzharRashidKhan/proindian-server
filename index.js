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

/* ================= SMART SUMMARY CLEANER ================= */

function cleanAndTrimSummary(text, minWords = 80, maxWords = 110) {
  if (!text) return "";

  // Remove URLs
  text = text.replace(/https?:\/\/\S+/g, "");

  // Remove twitter blocks
  text = text.replace(/pic\.twitter\.com\S*/g, "");
  text = text.replace(/—.*?(\.|\n)/g, "");

  // Remove brackets
  text = text.replace(/\[.*?\]/g, "");

  // Remove Also Read sections
  text = text.split("Also Read")[0];

  // Protect decimals like 2.5
  text = text.replace(/(\d)\.(\d)/g, "$1_DECIMAL_$2");

  text = text.replace(/\s+/g, " ").trim();

  const sentences = text.match(/[^\.!\?]+[\.!\?]+/g);
  if (!sentences) return "";

  let finalText = "";
  let wordCount = 0;

  for (const sentence of sentences) {
    const restored = sentence.replace(/_DECIMAL_/g, ".");
    const words = restored.trim().split(" ").length;

    if (wordCount + words > maxWords) break;

    finalText += restored.trim() + " ";
    wordCount += words;

    if (wordCount >= minWords) break;
  }

  return finalText.trim();
}

/* ================= CATEGORY ================= */

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

/* ================= BREAKING ================= */

function isBreaking(title) {
  const t = title.toLowerCase();
  return (
    t.includes("breaking") ||
    t.includes("live") ||
    t.includes("alert") ||
    t.includes("just in")
  );
}

/* ================= DUPLICATE CHECK ================= */

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

/* ================= DELETE OLD NEWS ================= */

async function deleteOldNews() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const snapshot = await db
      .collection("news")
      .where("timestamp", "<", sevenDaysAgo)
      .get();

    if (snapshot.empty) {
      console.log("No old news to delete");
      return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    console.log("Deleted old news:", snapshot.size);
  } catch (err) {
    console.error("Delete old news error:", err.message);
  }
}

/* ================= FETCH NEWS ================= */

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

      const summary = cleanAndTrimSummary(item.description);
      if (!summary) continue;

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

/* ================= CLEAN OLD SUMMARIES ================= */

async function cleanExistingSummaries() {
  console.log("Re-cleaning old summaries...");

  const snapshot = await db.collection("news").get();
  const batch = db.batch();
  let count = 0;

  snapshot.docs.forEach((doc) => {
    const data = doc.data();
    const cleaned = cleanAndTrimSummary(data.summary);

    if (cleaned && cleaned !== data.summary) {
      batch.update(doc.ref, { summary: cleaned });
      count++;
    }
  });

  if (count > 0) await batch.commit();
  console.log("Updated:", count);
}

/* ================= ROUTES ================= */

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
cleanExistingSummaries();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
