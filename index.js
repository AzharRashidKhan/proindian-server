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

/* ================= REGISTER FCM TOKEN ================= */

app.post("/register-token", async (req, res) => {
  try {
    const { token, language, interests } = req.body;

    await db.collection("fcmTokens").doc(token).set({
      token,
      language,
      interests: interests || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Token save error:", err.message);
    res.status(500).json({ success: false });
  }
});

/* ================= SEND BREAKING PUSH ================= */

async function sendBreakingPush(articleData, articleId) {
  try {
    const snapshot = await db
      .collection("fcmTokens")
      .where("language", "==", articleData.language)
      .where("interests", "array-contains", articleData.category)
      .get();

    const tokens = snapshot.docs.map((doc) => doc.data().token);

    if (tokens.length === 0) {
      console.log("No matching users for this push");
      return;
    }

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: "🚨 Breaking News",
        body: articleData.title,
      },
      data: {
        articleId,
      },
    });

    console.log("Push sent:", response.successCount);
  } catch (err) {
    console.error("Push error:", err.message);
  }
}

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

/* ================= CATEGORY MAP ================= */

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

    // 🔹 INDIA FULL CALL
    const indiaResponse = await axios.get(
      "https://newsdata.io/api/1/news",
      {
        params: {
          apikey: process.env.NEWSDATA_API_KEY,
          country: "in",
          language: lang,
        },
      }
    );

    // 🔹 OTHER CATEGORIES CALL
    const otherResponse = await axios.get(
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

    const combinedArticles = [
      ...(indiaResponse.data.results || []),
      ...(otherResponse.data.results || []),
    ];

    for (const item of combinedArticles) {
      if (!item.title || !item.link) continue;

      const summary = cleanAndTrimSummary(item.description);
      if (!summary) continue;

      // 🔒 DUPLICATE PROTECTION
      const existing = await db
        .collection("news")
        .where("sourceUrl", "==", item.link)
        .limit(1)
        .get();

      if (!existing.empty) continue;

      const category = mapCategory(item.category?.[0]);
      const breaking = isBreaking(item.title);

      const docRef = await db.collection("news").add({
        title: item.title,
        summary,
        category,
        language: lang,
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

      if (breaking) {
        await sendBreakingPush(
          {
            title: item.title,
            category,
            language: lang,
          },
          docRef.id
        );
      }
    }

    console.log(`${lang} news fetch completed`);
  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

async function fetchNews() {
  await fetchNewsByLanguage("en");
  await fetchNewsByLanguage("hi");
}

/* ================= VIEW ================= */

app.post("/news/:id/view", async (req, res) => {
  try {
    await db.collection("news").doc(req.params.id).update({
      views: admin.firestore.FieldValue.increment(1),
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* ================= NEWS ================= */

app.get("/news", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const category = req.query.category;
    const language = req.query.language || "en";

    let query = db.collection("news").where("language", "==", language);

    if (category && category !== "All") {
      query = query.where("category", "==", category);
    }

    query = query.orderBy("timestamp", "desc").limit(limit);

    const snapshot = await query.get();

    const articles = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ articles });
  } catch {
    res.status(500).json({ error: "Pagination failed" });
  }
});

/* ================= LIKE ================= */

app.post("/news/:id/like", async (req, res) => {
  try {
    const { deviceId } = req.body;
    const docRef = db.collection("news").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ success: false });

    const likedBy = doc.data().likedBy || [];

    if (!likedBy.includes(deviceId)) {
      await docRef.update({
        likes: admin.firestore.FieldValue.increment(1),
        likedBy: admin.firestore.FieldValue.arrayUnion(deviceId),
      });
    }

    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
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
