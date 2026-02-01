require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");
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

/* ================= SUMMARY CLEANER ================= */

function cleanAndTrimSummary(text, minWords = 80, maxWords = 110) {
  if (!text) return "";

  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/pic\.twitter\.com\S*/g, "");
  text = text.replace(/—.*?(\.|\n)/g, "");
  text = text.replace(/\[.*?\]/g, "");
  text = text.split("Also Read")[0];
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

/* ================= HELPERS ================= */

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

function isBreaking(title) {
  const t = title.toLowerCase();
  return (
    t.includes("breaking") ||
    t.includes("live") ||
    t.includes("alert") ||
    t.includes("just in")
  );
}

/* ================= DELETE OLD NEWS ================= */

async function deleteOldNews() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const snapshot = await db
      .collection("news")
      .where("timestamp", "<", sevenDaysAgo)
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    console.log("Deleted old news:", snapshot.size);
  } catch (err) {
    console.error("Delete old news error:", err.message);
  }
}

/* ================= FETCH NEWS ================= */

async function fetchNewsByLanguage(lang) {
  try {
    console.log(`Fetching ${lang} news...`);

    const response = await axios.get(
      "https://newsdata.io/api/1/news",
      {
        params: {
          apikey: process.env.NEWSDATA_API_KEY,
          country: "in",
          language: lang,
          category: "world,business,sports,technology,health",
        },
      }
    );

    const articles = response.data.results || [];

    for (const item of articles) {
      if (!item.title || !item.link) continue;

      const summary = cleanAndTrimSummary(item.description);
      if (!summary) continue;

      // Prevent duplicates by checking sourceUrl
      const existing = await db
        .collection("news")
        .where("sourceUrl", "==", item.link)
        .limit(1)
        .get();

      if (!existing.empty) continue;

      await db.collection("news").add({
        title: item.title,
        summary,
        category: mapCategory(item.category?.[0]),
        language: lang,
        source: item.source_id || "News",
        sourceUrl: item.link,
        image: item.image_url || "",
        breaking: isBreaking(item.title),
        likes: 0,
        views: 0,
        likedBy: [],
        viewedBy: [],
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    console.log(`${lang} news fetch completed`);
  } catch (err) {
    if (err.response) {
      console.error("NewsData Error:", err.response.data);
    } else {
      console.error("Fetch error:", err.message);
    }
  }
}

async function fetchNews() {
  await fetchNewsByLanguage("en");
  await fetchNewsByLanguage("hi");
}

/* ================= VIEW TRACKING ================= */

app.post("/news/:id/view", async (req, res) => {
  try {
    const id = req.params.id;

    await db.collection("news").doc(id).update({
      views: admin.firestore.FieldValue.increment(1),
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "View update failed" });
  }
});

/* ================= TRENDING ================= */

app.get("/news/trending", async (req, res) => {
  try {
    const language = req.query.language || "en";

    const snapshot = await db
      .collection("news")
      .where("language", "==", language)
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();

    const news = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(news);
  } catch (err) {
    res.status(500).json({ error: "Trending failed" });
  }
});

/* ================= NEWS ROUTE ================= */

app.get("/news", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const category = req.query.category;
    const lastTimestamp = req.query.lastTimestamp;
    const language = req.query.language || "en";

    let query = db
      .collection("news")
      .where("language", "==", language);

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pagination failed" });
  }
});

/* ================= CRON ================= */

cron.schedule("*/45 * * * *", fetchNews);
cron.schedule("0 3 * * *", deleteOldNews);

fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
