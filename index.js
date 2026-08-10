require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios");

const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const app = express();

app.use(helmet());
app.use(compression());

app.use(cors());
app.use(express.json());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

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

/* ================= MEMORY CACHE ================= */

const newsCache = new Map();
const trendingCache = {};
const tokenCache = new Map();
const viewQueue = new Map();
const likeQueue = new Map();

const knownUrls = new Set();

/*
Key example:
en_All
en_Sports
hi_All
hi_Business

Value:
{
  articles: [...],
  nextCursor: "...",
  expires: timestamp
}
*/
const CACHE_TIME = 60 * 1000; // 60 seconds
/* ================= REGISTER FCM TOKEN ================= */

app.post("/register-token", async (req, res) => {
  try {
    const { token, language, interests = [] } = req.body;

    if (!token) {
  return res.status(400).json({
    success: false,
    error: "Token is required",
  });
}

if (!["en", "hi"].includes(language)) {
  return res.status(400).json({
    success: false,
    error: "Invalid language",
  });
}

if (!Array.isArray(interests)) {
  return res.status(400).json({
    success: false,
    error: "Interests must be an array",
  });
}

    const cacheKey = token;
    const cacheValue = JSON.stringify({
      language,
      interests,
    });

    if (tokenCache.get(cacheKey) === cacheValue) {
      return res.json({
        success: true,
        cached: true,
      });
    }

    await db.collection("fcmTokens").doc(token).set({
      token,
      language,
      interests,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tokenCache.set(cacheKey, cacheValue);

    res.json({
      success: true,
      cached: false,
    });
  } catch (err) {
    console.error("Token save error:", err.message);
    res.status(500).json({ success: false });
  }
});

/* ================= PUSH LIMIT CONTROL ================= */

async function canSendPush() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const snapshot = await db
    .collection("pushLogs")
    .where("timestamp", ">", today)
    .get();

  return snapshot.size < 6;
}

/* ================= SEND BREAKING PUSH ================= */

async function sendBreakingPush(articleData, articleId) {
  try {
    const allowed = await canSendPush();
    if (!allowed) return;

    const snapshot = await db
      .collection("fcmTokens")
      .where("language", "==", articleData.language)
      .where("interests", "array-contains", articleData.category)
      .get();




const tokens = snapshot.docs.map((doc) => doc.data().token);


if (tokens.length === 0) {
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
    category: articleData.category,
    language: articleData.language,
  }
});


response.responses.forEach((r, i) => {
  if (!r.success) {
    console.error(
      `Push failed for token ${tokens[i]}:`,
      r.error
    );
  }
});
    await db.collection("pushLogs").add({
      articleId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
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
  .limit(500)
  .get();

    if (snapshot.empty) return;

   const batch = db.batch();

snapshot.docs.forEach((doc) => {
  const data = doc.data();

  if (data.sourceUrl) {
    knownUrls.delete(data.sourceUrl);
  }

  batch.delete(doc.ref);
});

await batch.commit();
  } catch (err) {
    console.error("Delete old news error:", err.message);
  }
}

/* ================= LOAD RECENT URL CACHE ================= */

async function loadKnownUrls() {
  try {
    knownUrls.clear();

    const snapshot = await db
  .collection("news")
  .orderBy("timestamp", "desc")
  .limit(300)
  .select("sourceUrl")
  .get();

    snapshot.forEach((doc) => {
      const url = doc.data().sourceUrl;

      if (url) {
        knownUrls.add(url);
      }
    });

    console.log(
      `Loaded ${knownUrls.size} recent URLs into RAM`
    );

  } catch (err) {
    console.error(
      "URL cache load failed:",
      err.message
    );
  }
}


/* ================= FETCH NEWS ================= */

async function fetchNewsByLanguage(lang) {
  try {
    const indiaResponse = await axios.get("https://newsdata.io/api/1/news", {
      params: {
        apikey: process.env.NEWSDATA_API_KEY,
        country: "in",
        language: lang,
        removeduplicate: 1,
      },
    });

    const otherResponse = await axios.get("https://newsdata.io/api/1/news", {
      params: {
        apikey: process.env.NEWSDATA_API_KEY,
        country: "in",
        language: lang,
        category: "world,business,sports,technology,health",
        removeduplicate: 1,
      },
    });

    const combinedArticles = [
      ...(indiaResponse.data.results || []),
      ...(otherResponse.data.results || []),
    ];

    for (const item of combinedArticles) {
      if (!item.title || !item.link) continue;

      if (item.duplicate) continue;

      const summary = cleanAndTrimSummary(item.description);
      if (!summary) continue;

      if (knownUrls.has(item.link)) {
  continue;
}

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

      knownUrls.add(item.link);

      if (breaking) {
        await sendBreakingPush(
          { title: item.title, category, language: lang },
          docRef.id
        );
      }
    }
  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

async function fetchNews() {

  newsCache.clear();

  await fetchNewsByLanguage("en");
  await fetchNewsByLanguage("hi");

  // Clear trending cache after fresh news
  delete trendingCache.en;
  delete trendingCache.hi;
}


app.get("/news/trending", async (req, res) => {
  try {
    const language = req.query.language || "en";

    const cache = trendingCache[language];

    // Cache valid for 5 minutes
    if (
      cache &&
      Date.now() - cache.timestamp < 5 * 60 * 1000
    ) {
      return res.json(cache.data);
    }

    const snapshot = await db
      .collection("news")
      .where("language", "==", language)
      .orderBy("timestamp", "desc")
      .limit(50)
      .get();

    const articles = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const scored = articles.map((a) => {
      const hoursOld = a.timestamp
        ? (Date.now() - a.timestamp.toDate().getTime()) / 3600000
        : 100;

      const baseScore =
        (a.views || 0) * 2 +
        (a.likes || 0) * 3 +
        (a.breaking ? 15 : 0);

      const timeFactor = 1 / (1 + hoursOld);

      return {
        ...a,
        score: baseScore * timeFactor,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    const result = scored.slice(0, 20);

    trendingCache[language] = {
      timestamp: Date.now(),
      data: result,
    };

    res.json(result);
  } catch (err) {
    console.error("Trending failed:", err.message);
    res.status(500).json({ error: "Trending failed" });
  }
});
/* ================= NEWS ================= */

app.get("/news", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const category = req.query.category;
    const language = req.query.language || "en";
    const cursor = req.query.cursor;

    const cacheKey = `${language}_${category || "All"}_${cursor || "first"}_${limit}`;

const cached = newsCache.get(cacheKey);

if (
  cached &&
  cached.expires > Date.now()
) {
  return res.json(cached.data);
}

    let query = db.collection("news")
      .where("language", "==", language);

    if (category && category !== "All") {
      query = query.where("category", "==", category);
    }

    query = query.orderBy("timestamp", "desc");

    if (cursor) {
      const cursorDoc = await db.collection("news").doc(cursor).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    query = query.limit(limit);

    const snapshot = await query.get();

    const articles = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    const lastDoc = snapshot.docs[snapshot.docs.length - 1];

    const response = {
  articles,
  nextCursor: lastDoc ? lastDoc.id : null,
};

// Save into RAM cache
newsCache.set(cacheKey, {
  data: response,
  expires: Date.now() + CACHE_TIME,
});

res.json(response);
} catch (err) {
  console.error("========== NEWS ROUTE ERROR ==========");
  console.error(err);

  return res.status(500).json({
    articles: [],
    nextCursor: null,
    error: err.message,
  });
}
  
});

/* ================= LIKE ================= */

app.post("/news/:id/like", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
  return res.status(400).json({
    success: false,
    error: "deviceId is required",
  });
}

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

app.post("/news/:id/view", async (req, res) => {
  try {
    const id = req.params.id;

    viewQueue.set(id, (viewQueue.get(id) || 0) + 1);

    res.json({ success: true });
  } catch (err) {
    console.error("View queue error:", err.message);
    res.status(500).json({ success: false });
  }
});

/* ================= ADMIN STATS ================= */

app.get("/admin/stats", async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).send("Forbidden");
  }

  try {
    const tokenSnapshot = await db.collection("fcmTokens").count().get();
    const newsSnapshot = await db.collection("news").count().get();

    res.json({
      status: "Online",

      uptime: Math.floor(process.uptime()),

      memory: process.memoryUsage(),

      node: process.version,

      newsArticles: newsSnapshot.data().count,

      registeredUsers: tokenSnapshot.data().count,

      newsCache: newsCache.size,

      trendingCache: Object.keys(trendingCache).length,

      knownUrls: knownUrls.size,

      viewQueue: viewQueue.size,

      likeQueue: likeQueue.size,
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ================= TEST PUSH ================= */

app.get("/test-push", async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).send("Forbidden");
  }

  try {
    await sendBreakingPush(
      {
        title: "🚨 Test Breaking News",
        category: "India",
        language: "en",
      },
      "test-article"
    );

    res.send("Push request sent.");
  } catch (err) {
    console.error("TEST PUSH ERROR:", err);
    res.status(500).send(err.message);
  }
});

/* ================= CRON ================= */

cron.schedule("*/45 * * * *", fetchNews);
cron.schedule("0 3 * * *", deleteOldNews);

fetchNews();

/* ================= SERVER ================= */

const PORT = process.env.PORT || 10000;

async function flushViewQueue() {
  if (viewQueue.size === 0) return;

  const batch = db.batch();

  for (const [id, count] of viewQueue.entries()) {
    const ref = db.collection("news").doc(id);

    batch.update(ref, {
      views: admin.firestore.FieldValue.increment(count),
    });
  }

  await batch.commit();

  viewQueue.clear();

  console.log("View queue flushed");
}

// Flush every 5 minutes
setInterval(flushViewQueue, 5 * 60 * 1000);

async function startServer() {
    await loadKnownUrls();

    app.listen(PORT, () => {
        console.log("Server running...");
    });
}

startServer();
