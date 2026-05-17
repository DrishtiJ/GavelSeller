const express = require("express");
const { ConvexHttpClient } = require("convex/browser");

const app = express();
app.use(express.json());

const convex = new ConvexHttpClient("https://marvelous-puma-505.convex.cloud");

const AGENTPHONE_API_KEY = "sk_live_bo6chz1u3ja0jNfTIs7rd3qOXyKZdBOi";
const AGENT_ID = "cmpa73n68098ijz00um9mbnxa";
const NUMBER_ID = "cmp90uxo000p9gd29wei6iofo";
const GEMINI_API_KEY = "";
const POLL_INTERVAL_MS = 2500;

const lastSeen = {};
const sessions = {};

const CATEGORIES = [
  "antiques", "appliances", "arts & crafts", "atvs/utvs/snowmobiles",
  "auto parts", "auto wheels & tires", "aviation", "baby & kid stuff",
  "barter", "bicycle parts", "bicycles", "boat parts", "boats",
  "books & magazines", "business/commercial", "cars & trucks", "cds/dvds/vhs",
  "cell phones", "clothing & accessories", "collectibles", "computer parts",
  "computers", "electronics", "farm & garden", "free stuff", "furniture",
  "garage & moving sales", "general for sale", "health and beauty",
  "heavy equipment", "household items", "jewelry", "materials",
  "motorcycle parts", "motorcycles/scooters", "musical instruments",
  "photo/video", "rvs", "sporting goods", "tickets", "tools",
  "toys & games", "trailers", "video gaming", "wanted"
];

// ── Gemini ────────────────────────────────────────────────────

async function geminiRaw(prompt) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0 },
        }),
      }
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error("Gemini error:", e.message);
    return null;
  }
}

// Extract all listing fields from any message in one call
async function extractAllFields(userText) {
  const prompt = `You are a Craigslist listing assistant. Extract any available listing info from the user's message and return ONLY a JSON object with these exact keys (null if not found):

{
  "name": "first name of the seller if mentioned, else null",
  "title": "a punchy 5-8 word Craigslist title generated from the item they mention, else null",
  "description": "a compelling 2-3 sentence Craigslist description rewritten from their words — highlight condition, features, appeal. null if not enough info",
  "price": "price as '$X' or 'free', null if not mentioned",
  "zipCode": "5-digit ZIP — if they mention a city infer the ZIP (e.g. Palo Alto=94301, San Jose=95110, NYC=10001, LA=90001, Chicago=60601, Atlanta=30301), null if unknown"
}

User message: "${userText}"

Return ONLY the JSON object. No explanation.`;

  const raw = await geminiRaw(prompt);
  try {
    const match = raw?.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : {};
    console.log("Gemini extracted:", JSON.stringify(result));
    return result;
  } catch {
    return {};
  }
}

async function geminiConfirmCategory(userText) {
  const raw = await geminiRaw(
    `User is confirming or changing a Craigslist category. Reply with just the category name they want, or "yes" if they confirmed.\nMessage: "${userText}"`
  );
  return raw?.toLowerCase().trim() || userText.toLowerCase();
}

function guessCategory(text) {
  text = (text || "").toLowerCase();
  if (/ps\d|xbox|nintendo|playstation|gaming|video game|console/.test(text)) return "video gaming";
  if (/iphone|android|samsung|pixel|cell phone/.test(text)) return "cell phones";
  if (/laptop|macbook|computer|pc|desktop/.test(text)) return "computers";
  if (/sofa|couch|table|chair|desk|dresser|bed/.test(text)) return "furniture";
  if (/car|truck|suv|van|honda|toyota|ford|bmw/.test(text)) return "cars & trucks";
  if (/motorcycle|harley|kawasaki|yamaha/.test(text)) return "motorcycles/scooters";
  if (/bicycle|bike/.test(text)) return "bicycles";
  if (/guitar|piano|drum|keyboard|instrument/.test(text)) return "musical instruments";
  if (/camera|lens|tripod|dslr/.test(text)) return "photo/video";
  if (/shirt|pants|shoes|jacket|dress|clothing/.test(text)) return "clothing & accessories";
  if (/book|novel|textbook|magazine/.test(text)) return "books & magazines";
  if (/tool|drill|saw|wrench/.test(text)) return "tools";
  if (/fridge|washer|dryer|dishwasher|oven/.test(text)) return "appliances";
  if (/tv|television|monitor|speaker|headphone/.test(text)) return "electronics";
  if (/toy|lego|doll/.test(text)) return "toys & games";
  if (/ring|necklace|bracelet|jewelry/.test(text)) return "jewelry";
  if (/baby|stroller|crib|infant/.test(text)) return "baby & kid stuff";
  if (/sport|gym|fitness|weight/.test(text)) return "sporting goods";
  if (/bottle|cup|mug|kitchen/.test(text)) return "household items";
  if (/cap|hat|beanie/.test(text)) return "clothing & accessories";
  if (/free/.test(text)) return "free stuff";
  return "general for sale";
}

// ── Session helpers ───────────────────────────────────────────

function getSession(conversationId, participant) {
  if (!sessions[conversationId]) {
    sessions[conversationId] = {
      state: "start",
      data: { name: null, title: null, description: null, price: null, zip: null, category: null, images: [] },
      participant,
    };
  }
  return sessions[conversationId];
}

// Merge extracted fields into session without overwriting existing values
function mergeFields(session, extracted) {
  if (extracted.name && !session.data.name) session.data.name = extracted.name;
  if (extracted.title && !session.data.title) session.data.title = extracted.title;
  if (extracted.description && !session.data.description) session.data.description = extracted.description;
  if (extracted.price && !session.data.price) session.data.price = extracted.price;
  if (extracted.zipCode && !session.data.zip) session.data.zip = extracted.zipCode;
}

// Determine which state to move to next based on what's still missing
function nextMissingState(session) {
  const d = session.data;
  if (!d.name) return "ask_name";
  if (!d.title) return "ask_item";
  if (!d.description) return "ask_description";
  if (!d.price) return "ask_price";
  if (!d.zip) return "ask_zip";
  return "ask_images";
}

function buildNextQuestion(session, prefix = "") {
  const d = session.data;
  const pre = prefix ? prefix + " " : "";
  switch (session.state) {
    case "ask_name":        return `${pre}What's your first name?`;
    case "ask_item":        return `${pre}What are you selling?`;
    case "ask_description": return `${pre}Can you describe it? (condition, age, brand, any flaws)`;
    case "ask_price":       return `${pre}What price are you asking? (or "free")`;
    case "ask_zip":         return `${pre}What's your ZIP code?`;
    case "ask_images":
      return d.images.length > 0
        ? `${pre}Send more photos or type "done" when finished.`
        : `${pre}Please share at least one photo 📸 Type "done" when finished.`;
    default: return `${pre}How can I help?`;
  }
}

// ── AgentPhone ────────────────────────────────────────────────

async function sendMessage(toNumber, body) {
  const res = await fetch("https://api.agentphone.ai/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${AGENTPHONE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: AGENT_ID, number_id: NUMBER_ID, to_number: toNumber, body }),
  });
  const data = await res.json();
  console.log("→", body.substring(0, 80));
  return data;
}

// ── Convex ────────────────────────────────────────────────────

async function saveToConvex(conversationId, participant, session) {
  const { data } = session;
  try {
    await convex.mutation("listings:upsertListing", {
      conversationId,
      participantNumber: participant,
      ...(data.name && { userName: data.name }),
      ...(data.title && { title: data.title }),
      ...(data.description && { description: data.description }),
      ...(data.price && { price: data.price }),
      ...(data.zip && { zipCode: data.zip }),
      ...(data.category && { category: data.category }),
      images: data.images,
      status: session.state === "done" ? "complete" : "in_progress",
    });
  } catch (e) {
    console.error("Convex error:", e.message);
  }
}

// ── Summary ───────────────────────────────────────────────────

function buildSummary(session) {
  const d = session.data;
  return `Here's your Gavel listing, ${d.name}! 🎉

Title: ${d.title}
Description: ${d.description}
Price: ${d.price}
ZIP Code: ${d.zip}
Category: ${d.category}
Images: ${d.images.length} photo(s) received

Everything look good? Reply "yes" to confirm or tell me what to change.`;
}

// ── Main message handler ──────────────────────────────────────

async function handleMessage(conversationId, participant, text, mediaUrl) {
  const session = getSession(conversationId, participant);

  // Always collect images regardless of state
  if (mediaUrl) {
    session.data.images.push(mediaUrl);
    console.log("Image saved:", mediaUrl);
  }

  const t = (text || "").trim();

  // If only an image was sent (no text) outside images step, acknowledge and re-ask
  if (mediaUrl && !t && session.state !== "ask_images") {
    const next = buildNextQuestion(session, "Got your photo — saved! 📸 Now,");
    await sendMessage(participant, next);
    await saveToConvex(conversationId, participant, session);
    return;
  }

  // Skip processing if no meaningful text and no image
  if (!t && !mediaUrl) return;

  let reply = "";

  switch (session.state) {

    case "start":
      session.state = "ask_name";
      reply = "Hey! Welcome to Gavel 👋 I'm here to help you list your item on Craigslist. What's your first name?";
      break;

    case "ask_name":
    case "ask_item":
    case "ask_description":
    case "ask_price":
    case "ask_zip": {
      // Extract ALL fields from the message at once
      const extracted = await extractAllFields(t);

      // If asking for name specifically, also try to get it directly
      if (session.state === "ask_name" && !extracted.name) {
        extracted.name = t.split(" ")[0];
      }

      // Merge into session (never overwrites already-set fields)
      mergeFields(session, extracted);

      // For the field we were specifically asking about, allow overwrite
      if (session.state === "ask_item" && extracted.title) session.data.title = extracted.title;
      if (session.state === "ask_description" && extracted.description) session.data.description = extracted.description;
      if (session.state === "ask_price" && extracted.price) session.data.price = extracted.price;
      if (session.state === "ask_zip" && extracted.zipCode) session.data.zip = extracted.zipCode;

      // Check if the field we asked for is now filled
      const wasAsking = session.state;
      const filled = {
        ask_name: !!session.data.name,
        ask_item: !!session.data.title,
        ask_description: !!session.data.description,
        ask_price: !!session.data.price,
        ask_zip: !!session.data.zip,
      };

      if (!filled[wasAsking]) {
        // Still missing — ask again
        reply = buildNextQuestion(session, "I didn't quite catch that.");
        break;
      }

      // Advance to next missing field
      const next = nextMissingState(session);
      session.state = next;

      // Summarize what we got and what's still missing
      const d = session.data;
      const got = [];
      const missing = [];
      if (d.name) got.push(`name (${d.name})`);
      if (d.title) got.push(`title`);
      if (d.description) got.push(`description`);
      if (d.price) got.push(`price (${d.price})`);
      if (d.zip) got.push(`ZIP (${d.zip})`);
      if (!d.title) missing.push("title");
      if (!d.description) missing.push("description");
      if (!d.price) missing.push("price");
      if (!d.zip) missing.push("ZIP code");
      missing.push("photos"); // always need photos

      let prefix = "";
      if (wasAsking === "ask_name") prefix = `Nice to meet you, ${d.name}!`;

      // If we got multiple fields at once, summarize them
      if (got.length > 1 || (wasAsking !== "ask_name" && got.length > 0)) {
        prefix = `Got it! I picked up: ${got.join(", ")}. Still need: ${missing.join(", ")}.`;
      }

      reply = buildNextQuestion(session, prefix);
      break;
    }

    case "ask_images":
      if (mediaUrl) {
        reply = `Got the photo! Send more or type "done" when finished.`;
      } else if (/^done\.?$/i.test(t)) {
        if (session.data.images.length === 0) {
          reply = `Please send at least one photo first, then type "done".`;
        } else {
          const suggested = guessCategory((session.data.title || "") + " " + (session.data.description || ""));
          session.data.category = suggested;
          session.state = "confirm_category";
          reply = `Great, ${session.data.images.length} photo(s) received! 📸\n\nBased on your item, I'd suggest: *${suggested}*\n\nDoes that work? (Reply "yes" or suggest a different one)`;
        }
      } else {
        reply = `Send your photos and type "done" when finished.`;
      }
      break;

    case "confirm_category": {
      const catReply = await geminiConfirmCategory(t);
      if (catReply === "yes") {
        session.state = "confirm_summary";
        reply = buildSummary(session);
      } else {
        const matched = CATEGORIES.find((c) => c.includes(catReply)) || catReply;
        session.data.category = matched;
        session.state = "confirm_summary";
        reply = buildSummary(session);
      }
      break;
    }

    case "confirm_summary":
      if (/^yes|looks good|good|correct|perfect/i.test(t)) {
        session.state = "done";
        reply = `Your listing is saved, ${session.data.name}! 🎉 Good luck with the sale!`;
      } else {
        reply = `No problem! What would you like to change? (title, description, price, zip, photos, or category)`;
        session.state = "edit";
      }
      break;

    case "edit":
      if (/title|item/i.test(t)) { session.state = "ask_item"; session.data.title = null; reply = "What are you selling?"; }
      else if (/desc/i.test(t)) { session.state = "ask_description"; session.data.description = null; reply = "Describe the item:"; }
      else if (/price/i.test(t)) { session.state = "ask_price"; session.data.price = null; reply = "What's the price?"; }
      else if (/zip/i.test(t)) { session.state = "ask_zip"; session.data.zip = null; reply = "What's your ZIP code?"; }
      else if (/photo|image/i.test(t)) { session.data.images = []; session.state = "ask_images"; reply = `Send your new photos, then type "done".`; }
      else if (/category/i.test(t)) { session.state = "confirm_category"; reply = "What category would you like?"; }
      else { reply = `Which field? Reply: title, description, price, zip, photos, or category.`; }
      break;

    case "done":
      // Reset for new listing
      session.state = "ask_name";
      session.data = { name: null, title: null, description: null, price: null, zip: null, category: null, images: [] };
      reply = "Welcome back! 👋 Let's create a new listing. What's your first name?";
      break;

    default:
      session.state = "start";
      reply = "Hey! Welcome to Gavel 👋 What's your first name?";
  }

  if (reply) {
    await sendMessage(participant, reply);
    await saveToConvex(conversationId, participant, session);
  }
}

// ── Polling ───────────────────────────────────────────────────

async function initLastSeen() {
  try {
    const res = await fetch("https://api.agentphone.ai/v1/conversations?limit=20", {
      headers: { Authorization: `Bearer ${AGENTPHONE_API_KEY}` },
    });
    const { data: conversations } = await res.json();
    for (const conv of conversations || []) {
      const msgRes = await fetch(
        `https://api.agentphone.ai/v1/conversations/${conv.id}/messages?limit=50`,
        { headers: { Authorization: `Bearer ${AGENTPHONE_API_KEY}` } }
      );
      const { data: messages } = await msgRes.json();
      if (messages?.length > 0) {
        const latest = messages.map((m) => m.receivedAt).sort().reverse()[0];
        lastSeen[conv.id] = latest;
        console.log(`Init: ${conv.id} → ${latest}`);
      }
    }
  } catch (e) {
    console.error("Init error:", e.message);
  }
}

async function poll() {
  try {
    const res = await fetch("https://api.agentphone.ai/v1/conversations?limit=20", {
      headers: { Authorization: `Bearer ${AGENTPHONE_API_KEY}` },
    });
    const { data: conversations } = await res.json();

    for (const conv of conversations || []) {
      const msgRes = await fetch(
        `https://api.agentphone.ai/v1/conversations/${conv.id}/messages?limit=20`,
        { headers: { Authorization: `Bearer ${AGENTPHONE_API_KEY}` } }
      );
      const { data: messages } = await msgRes.json();

      const inbound = (messages || [])
        .filter((m) => m.direction === "inbound")
        .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));

      const last = lastSeen[conv.id] || "1970-01-01T00:00:00Z";
      const newMsgs = inbound.filter((m) => m.receivedAt > last);

      for (const msg of newMsgs) {
        console.log(`\n← ${conv.participant}: ${msg.body || "[image]"}`);
        lastSeen[conv.id] = msg.receivedAt;
        await handleMessage(conv.id, conv.participant, msg.body, msg.mediaUrl);
      }
    }
  } catch (e) {
    console.error("Poll error:", e.message);
  }
  setTimeout(poll, POLL_INTERVAL_MS);
}

// ── Server ────────────────────────────────────────────────────

app.get("/", (req, res) => res.send("Gavel server running."));
app.get("/webhook", (req, res) => res.send("Gavel webhook is live ✅"));

app.listen(3000, async () => {
  console.log("Gavel server running on http://localhost:3000");
  console.log("Initializing — skipping old messages...");
  await initLastSeen();
  console.log("Ready! Polling every 2.5s\n");
  poll();
});
