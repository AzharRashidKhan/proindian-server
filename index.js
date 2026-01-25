require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 Firebase Admin Setup
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 🔥 Fetch News Function
async function fetchNews() {
  try {
    console.log("Fetching news...");

    const newsResponse = await axios.get(
      `https://newsapi.org/v2/top-headlines`,
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

      // 🔎 Check duplicate
      const existing = await db
        .collection("news")
        .where("title", "==", article.title)
        .get();

      if (!existing.empty) {
        console.log("Skipped duplicate:", article.title);
        continue;
      }

      // 🤖 AI Prompt
      const aiPrompt = `
You are a professional news editor.

Your task:
1. Write a crisp, factual summary in maximum 50 words.
2. Detect the correct category from this list only:
India, World, Business, Sports, Technology

Rules:
- Strictly under 50 words
- Neutral tone
- No emojis
- No opinions
- Do not repeat headline
- Return ONLY valid JSON

Format:
{
  "summary": "your summary here",
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

        try {
          const parsed = JSON.parse(aiText);
          aiSummary = parsed.summary;
          aiCategory = parsed.category;
        } catch (err) {
          console.log("AI JSON parse error. Skipping article.");
          continue;
        }
      } catch (error) {
        console.log("AI request failed. Skipping article.");
        continue;
      }

      // 💾 Save to Firestore
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

// 🚀 Run Every 30 Minutes
cron.schedule("*/30 * * * *", fetchNews);

// Run once on server start
fetchNews();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
