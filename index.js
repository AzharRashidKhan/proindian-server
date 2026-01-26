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

    const newsResponse = await axios.get(
      "https://newsapi.org/v2/top-headlines",
      {
        params: {
          country: "in",
          pageSize: 5,
          apiKey: process.env.NEWS_API_KEY,
        },
      }
    );

    const articles = newsResponse.data.articles;

    for (const article of articles) {
      if (!article.title || !article.url) continue;

      // Check duplicate by title
      const existing = await db
        .collection("news")
        .where("title", "==", article.title)
        .get();

      if (!existing.empty) {
        console.log("Skipped duplicate:", article.title);
        continue;
      }

      const aiPrompt = `
You are a professional news editor.

Write a factual summary in maximum 50 words.
Detect correct category from:
India, World, Business, Sports, Technology

Rules:
- Under 50 words
- Neutral tone
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
        aiCategory = parsed.category;
      } catch (error) {
        console.log("AI failed. Skipping article.");
        continue;
      }

      await db.collection("news").add({
        title: article.title,
        summary: aiSummary,
        category: aiCategory,
        source: article.source.name,
        sourceUrl: article.url,
        image: article.urlToImage || "",
        timestamp: new Date(article.publishedAt || Date.now()),
      });

      console.log("Saved with AI summary:", article.title);
    }

    console.log("News fetch completed.");
  } catch (error) {
    console.error("Error fetching news:", error.message);
  }
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => {
  res.send("ProIndian News Server is running 🚀");
});

/* ================= CRON ================= */

// Every 30 minutes
cron.schedule("*/30 * * * *", fetchNews);

// Run once on start
fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;

// 🔥 GET Latest News API
app.get("/news", async (req, res) => {
  try {
    const snapshot = await db
      .collection("news")
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();

    const news = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

     res.json(news);
   } catch (error) {
     console.error("Error fetching news:", error);
     res.status(500).json({ error: "Failed to fetch news" });
    }
   });

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
