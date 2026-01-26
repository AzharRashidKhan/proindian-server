require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

/* ==============================
   FIREBASE INITIALIZATION
============================== */

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ==============================
   CATEGORY CONFIG
============================== */

const VALID_CATEGORIES = [
  "India",
  "World",
  "Business",
  "Sports",
  "Technology",
  "Health",
];

/* ==============================
   SIMPLE MEMORY CACHE
============================== */

let cachedNews = [];
let lastFetchTime = 0;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

/* ==============================
   FETCH + AI PROCESSING
============================== */

async function fetchNews() {
  try {
    console.log("Fetching news...");

    const newsResponse = await axios.get(
      "https://newsapi.org/v2/top-headlines",
      {
        params: {
          country: "in",
          pageSize: 10,
          apiKey: process.env.NEWS_API_KEY,
        },
      }
    );

    const articles = newsResponse.data.articles;

    for (const article of articles) {
      if (!article.title || !article.url) continue;

      // 🔎 Check duplicate
      const existing = await db
        .collection("news")
        .where("title", "==", article.title)
        .limit(1)
        .get();

      if (!existing.empty) {
        console.log("Skipped duplicate:", article.title);
        continue;
      }

      // 🤖 AI Prompt
      const aiPrompt = `
You are a professional news editor.

Write:
1) A factual summary (maximum 50 words).
2) Detect correct category from:

India – Indian politics, courts, governance
World – International affairs
Business – Economy, banking, corporate
Sports – Cricket, football, tournaments
Technology – AI, startups, gadgets
Health – Medical, hospitals, research

Rules:
- Under 50 words
- Neutral tone
- No emojis
- No opinions
- Return ONLY valid JSON

Format:
{
  "summary": "text",
  "category": "India"
}

Article:
${article.description || article.content || article.title}
`;

      let aiSummary = "";
      let aiCategory = "India";

      try {
        const aiResponse = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: aiPrompt }],
            temperature: 0.3,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );

        const aiText = aiResponse.data.choices[0].message.content;

        const parsed = JSON.parse(aiText);

        aiSummary = parsed.summary;

        // ✅ Category validation
        if (VALID_CATEGORIES.includes(parsed.category)) {
          aiCategory = parsed.category;
        } else {
          aiCategory = "India";
        }
      } catch (err) {
        console.log("AI failed. Skipping article.");
        continue;
      }

      // 💾 Save to Firestore
      await db.collection("news").add({
        title: article.title,
        summary: aiSummary,
        category: aiCategory,
        image: article.urlToImage || "",
        source: article.source?.name || "",
        sourceUrl: article.url,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("Saved:", article.title);
    }

    lastFetchTime = Date.now();
    console.log("News fetch completed.");
  } catch (error) {
    console.error("Fetch error:", error.message);
  }
}

/* ==============================
   API ROUTE
============================== */

app.get("/news", async (req, res) => {
  try {
    const now = Date.now();

    // Use cache if valid
    if (cachedNews.length > 0 && now - lastFetchTime < CACHE_DURATION) {
      return res.json(cachedNews);
    }

    const snapshot = await db
      .collection("news")
      .orderBy("timestamp", "desc")
      .limit(50)
      .get();

    const news = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    cachedNews = news;
    lastFetchTime = now;

    res.json(news);
  } catch (error) {
    console.error("API error:", error.message);
    res.status(500).json({ error: "Failed to load news" });
  }
});

/* ==============================
   CRON JOB
============================== */

// Every 30 minutes
cron.schedule("*/30 * * * *", fetchNews);

// Run once at startup
fetchNews();

/* ==============================
   SERVER START
============================== */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});