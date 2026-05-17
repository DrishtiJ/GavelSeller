const express = require("express");
const { ConvexHttpClient } = require("convex/browser");

const app = express();
app.use(express.json());

const convex = new ConvexHttpClient("https://marvelous-puma-505.convex.cloud");

const AGENTPHONE_API_KEY = "sk_live_bo6chz1u3ja0jNfTIs7rd3qOXyKZdBOi";
const AGENT_ID = "cmpa73n68098ijz00um9mbnxa";
const NUMBER_ID = "cmp90uxo000p9gd29wei6iofo";
const GEMINI_API_KEY = "AIzaSyDoKMi3OdRanezFSyJys3KxfKUMOm-Muyw";
const POLL_INTERVAL_MS = 2500;

async function geminiExtract(prompt) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 100, temperature: 0 },
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

async function extractField(state, userText) {
  const prompts = {
    ask_name: `Extract only the first name from this message. Reply with just the name, nothing else.\nMessage: "${userText}"`,
    ask_item: `Extract a short, clean item title (3-6 words) from this message for a Craigslist listing. Reply with just the title.\nMessage: "${userText}"`,
    ask_description: `Clean up this item description for a Craigslist listing. Keep it natural but fix any typos. Reply with just the description.\nMessage: "${userText}"`,
    ask_price: `Extract the price from this message. Format as "$X" or "free". If unclear, reply "unknown".\nMessage: "${userText}"`,
    ask_zip: `Extract the 5-digit US ZIP code from this message. Reply with just the 5 digits. If none found, reply "unknown".\nMessage: "${userText}"`,
    confirm_category: `The user is confirming or changing a Craigslist category. Reply with just the category name they want, or "yes" if they confirmed.\nMessage: "${userText}"`,
  };
  if (!prompts[state]) return userText;
  const result = await geminiExtract(prompts[state]);
  console.log(`Gemini [${state}]: "${userText}" → "${result}"`);
  return result || userText;
}

// Track last processed message per conversation
const lastSeen = {}; // conversationId -> last inbound message receivedAt

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

// In-memory conversation state
const sessions = {};

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

function guessCategory(text) {
  text = text.toLowerCase();
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
  if (/free/.test(text)) return "free stuff";
  return "general for sale";
}

async function sendMessage(toNumber, body) {
  const res = await fetch("https://api.agentphone.ai/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AGENTPHONE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent_id: AGENT_ID, number_id: NUMBER_ID, to_number: toNumber, body }),
  });
  const data = await res.json();
  console.log("→ Sent:", body.substring(0, 80));
  return data;
}

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

async function handleMessage(conversationId, participant, text, mediaUrl) {
  const session = getSession(conversationId, participant);

  if (mediaUrl) {
    session.data.images.push(mediaUrl);
    console.log("Image received:", mediaUrl);
  }

  const t = (text || "").trim();
  let reply = "";

  switch (session.state) {
    case "start":
      session.state = "ask_name";
      reply = "Hey! Welcome to Gavel 👋 I'm here to help you list your item on Craigslist in just a few steps. What's your first name?";
      break;

    case "ask_name": {
      const name = await extractField("ask_name", t);
      session.data.name = name;
      session.state = "ask_item";
      reply = `Nice to meet you, ${name}! What are you selling today?`;
      break;
    }

    case "ask_item": {
      const title = await extractField("ask_item", t);
      session.data.title = title;
      session.state = "ask_description";
      reply = `Got it — "${title}"! Can you describe it a bit more? Things like condition (new/used), age, brand, and any flaws.`;
      break;
    }

    case "ask_description": {
      const desc = await extractField("ask_description", t);
      session.data.description = desc;
      session.state = "ask_price";
      reply = `Perfect! What price are you asking? (Say "free" if you're giving it away.)`;
      break;
    }

    case "ask_price": {
      const price = await extractField("ask_price", t);
      if (price === "unknown") {
        reply = `Hmm, I didn't catch a price. Could you say something like "$50" or "free"?`;
        break;
      }
      session.data.price = price;
      session.state = "ask_zip";
      reply = `Got it! What's your ZIP code so buyers know where to find the item?`;
      break;
    }

    case "ask_zip": {
      const zip = await extractField("ask_zip", t);
      if (zip === "unknown") {
        reply = `I didn't catch a ZIP code — could you share your 5-digit ZIP?`;
        break;
      }
      session.data.zip = zip;
      session.state = "ask_images";
      if (session.data.images.length > 0) {
        reply = `Thanks! I already have ${session.data.images.length} photo(s). Send more or type "done" when finished.`;
      } else {
        reply = `Almost there! Please share at least one photo 📸 Good photos = faster sales. Type "done" when you've sent all your photos.`;
      }
      break;
    }

    case "ask_images":
      if (mediaUrl && !t) {
        reply = `Got the photo! Send more or type "done" when finished.`;
      } else if (t.toLowerCase() === "done") {
        if (session.data.images.length === 0) {
          reply = `Please send at least one photo first, then type "done".`;
        } else {
          const suggested = guessCategory(session.data.title + " " + session.data.description);
          session.data.category = suggested;
          session.state = "confirm_category";
          reply = `Great, ${session.data.images.length} photo(s) received! 📸\n\nBased on your item, I'd suggest the category: *${suggested}*\n\nDoes that work? (Reply "yes" or suggest a different one)`;
        }
      } else if (mediaUrl) {
        reply = `Got it! Send more photos or type "done" when finished.`;
      } else {
        reply = `Send your photos and type "done" when you're finished.`;
      }
      break;

    case "confirm_category": {
      const catReply = await extractField("confirm_category", t);
      if (catReply?.toLowerCase() === "yes") {
        session.state = "confirm_summary";
        reply = buildSummary(session);
      } else {
        const matched = CATEGORIES.find((c) => c.includes((catReply || t).toLowerCase())) || catReply || t;
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
        reply = `No problem! What would you like to change? (name, title, description, price, zip, photos, or category)`;
        session.state = "edit";
      }
      break;

    case "edit":
      if (/title|item/i.test(t)) { session.state = "ask_item"; reply = "What are you selling?"; }
      else if (/desc/i.test(t)) { session.state = "ask_description"; reply = "Describe the item:"; }
      else if (/price/i.test(t)) { session.state = "ask_price"; reply = "What's the price?"; }
      else if (/zip/i.test(t)) { session.state = "ask_zip"; reply = "What's your ZIP code?"; }
      else if (/photo|image/i.test(t)) { session.data.images = []; session.state = "ask_images"; reply = "Send your new photos, then type \"done\"."; }
      else if (/category/i.test(t)) { session.state = "confirm_category"; reply = "What category would you like?"; }
      else if (/name/i.test(t)) { session.state = "ask_name"; reply = "What's your name?"; }
      else { reply = `Which field? Reply with: name, title, description, price, zip, photos, or category.`; }
      break;

    case "done":
      // Any message resets for a new listing
      session.state = "ask_name";
      session.data = { name: null, title: null, description: null, price: null, zip: null, category: null, images: [] };
      reply = "Welcome back to Gavel! 👋 Let's create a new listing. What's your first name?";
      break;

    default:
      session.state = "start";
      reply = "Hey! Welcome to Gavel 👋 What's your first name?";
  }

  await sendMessage(participant, reply);
  await saveToConvex(conversationId, participant, session);
}

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

// ── Polling loop ──────────────────────────────────────────────
async function initLastSeen() {
  // Set lastSeen to the latest message in each conversation so we
  // don't reprocess history on startup
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
      if (messages && messages.length > 0) {
        const latest = messages
          .map((m) => m.receivedAt)
          .sort()
          .reverse()[0];
        lastSeen[conv.id] = latest;
        console.log(`Init: conv ${conv.id} → lastSeen ${latest}`);
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
      const convId = conv.id;
      const participant = conv.participant;

      const msgRes = await fetch(
        `https://api.agentphone.ai/v1/conversations/${convId}/messages?limit=20`,
        { headers: { Authorization: `Bearer ${AGENTPHONE_API_KEY}` } }
      );
      const { data: messages } = await msgRes.json();

      const inbound = (messages || [])
        .filter((m) => m.direction === "inbound")
        .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));

      const last = lastSeen[convId] || "1970-01-01T00:00:00Z";
      const newMessages = inbound.filter((m) => m.receivedAt > last);

      for (const msg of newMessages) {
        console.log(`\n← ${participant}: ${msg.body || "[image]"}`);
        lastSeen[convId] = msg.receivedAt;
        await handleMessage(convId, participant, msg.body, msg.mediaUrl);
      }
    }
  } catch (e) {
    console.error("Poll error:", e.message);
  }

  setTimeout(poll, POLL_INTERVAL_MS);
}

app.get("/", (req, res) => res.send("Gavel server running."));
app.get("/webhook", (req, res) => res.send("Gavel webhook is live ✅"));

app.listen(3000, async () => {
  console.log("Gavel server running on http://localhost:3000");
  console.log("Initializing — skipping old messages...");
  await initLastSeen();
  console.log("Ready! Polling for new messages every 2.5s\n");
  poll();
});
