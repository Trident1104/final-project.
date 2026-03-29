const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();
const Groq = require("groq-sdk");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ══════════════════════════════════════════════════════════════
//  WIKIPEDIA API — Node 22 has native fetch built in
// ══════════════════════════════════════════════════════════════
async function fetchWikipedia(query) {
  try {
    const cleaned = query
      .replace(/what is|what are|how does|how do|why is|why are|tell me about|explain|define/gi, "")
      .replace(/[?!.,]/g, "")
      .trim();

    // Step 1: Search Wikipedia
    const searchUrl = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(cleaned) + "&format=json&srlimit=3&utf8=1";

    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    const results = searchData?.query?.search;
    if (!results || results.length === 0) return null;

    // Pick best article title
    let pageTitle = results[0].title;
    for (const r of results) {
      const t = r.title.toLowerCase();
      if (t.includes("disease") || t.includes("syndrome") || t.includes("infection") ||
          t.includes("vitamin") || t.includes("cancer") || t.includes("fever") ||
          t.includes("virus") || t.includes("bacteria") || t.includes("disorder")) {
        pageTitle = r.title;
        break;
      }
    }

    // Step 2: Get article summary
    const summaryUrl = "https://en.wikipedia.org/api/rest_v1/page/summary/" +
      encodeURIComponent(pageTitle);
    const summaryRes = await fetch(summaryUrl);
    const page = await summaryRes.json();
    const extract = page?.extract;
    if (!extract || extract.length < 40) return null;

    return { title: page.title, extract };
  } catch (err) {
    console.error("Wikipedia error:", err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  GROQ — simplify Wikipedia answer
// ══════════════════════════════════════════════════════════════
async function simplifyWithGroq(wikiExtract, question, language, history) {
  const isHindi = language === "hi";

  const systemPrompt = isHindi
    ? `You are a health assistant. CRITICAL: Reply ONLY in Hindi Devanagari script. Never use English. Summarize the Wikipedia text to answer the question in 2-3 simple Hindi sentences. Easy words only.`
    : `You are a helpful health assistant. Use the Wikipedia information to answer in 2-3 simple clear sentences. Easy words. No jargon. No warnings.`;

  const userContent = isHindi
    ? `Wikipedia जानकारी: "${wikiExtract.substring(0, 500)}"\n\nसवाल: ${question}\n\n[केवल हिंदी में जवाब दें।]`
    : `Wikipedia info: "${wikiExtract.substring(0, 500)}"\n\nQuestion: ${question}\n\nAnswer in 2-3 simple sentences.`;

  const recentHistory = history.slice(-4);

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    max_tokens: 200,
    messages: [
      { role: "system", content: systemPrompt },
      ...recentHistory.slice(0, -1),
      { role: "user", content: userContent }
    ],
  });
  return completion.choices[0].message.content.trim();
}

// ══════════════════════════════════════════════════════════════
//  GROQ — direct answer fallback
// ══════════════════════════════════════════════════════════════
async function groqDirectAnswer(messages, language) {
  const isHindi = language === "hi";

  const systemPrompt = isHindi
    ? `You are a health assistant. CRITICAL: Reply ONLY in Hindi Devanagari script. Never use English. Answer in 2-3 simple Hindi sentences. No jargon.`
    : `You are a helpful health assistant. Answer in 2-3 simple clear sentences. No jargon. No warnings.`;

  const processedMessages = messages.slice(-6).map(msg => {
    if (isHindi && msg.role === "user") {
      return { ...msg, content: msg.content + "\n[Reply ONLY in Hindi Devanagari. No English.]" };
    }
    return msg;
  });

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    max_tokens: 200,
    messages: [
      { role: "system", content: systemPrompt },
      ...processedMessages
    ],
  });
  return completion.choices[0].message.content.trim();
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/ask", async (req, res) => {
  const { question, messages = [], language = "en" } = req.body;

  if (!question || question.trim() === "")
    return res.status(400).json({ success: false, error: "Please provide a question." });

  // Step 1: Try Wikipedia
  const wikiResult = await fetchWikipedia(question);

  if (wikiResult) {
    try {
      const answer = await simplifyWithGroq(wikiResult.extract, question, language, messages);
      return res.json({ success: true, question, answer, source: "wikipedia" });
    } catch (err) {
      console.error("Groq simplify error:", err.message);
    }
  }

  // Step 2: Groq direct fallback
  try {
    const answer = await groqDirectAnswer(messages, language);
    return res.json({ success: true, question, answer, source: "ai" });
  } catch (err) {
    console.error("Groq error:", err.message);
    return res.status(500).json({ success: false, error: "Could not get an answer. Please try again." });
  }
});

app.get("/api/questions", (req, res) => {
  res.json({ success: true, total: "Wikipedia — unlimited topics" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ HealthQ running on port " + PORT);
  console.log("🌐 Wikipedia + Groq LLaMA 3.1 8B ready!");
});
