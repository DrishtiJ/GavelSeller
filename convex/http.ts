import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const GAVEL_SYSTEM_PROMPT = `You are a friendly listing assistant for Gavel, a platform that helps people create Craigslist posts quickly and easily. Your job is to collect all the information needed to create a complete Craigslist listing through a natural, conversational flow.

GREETING BEHAVIOR:
When the user says "hi" or any greeting, warmly welcome them to Gavel and immediately ask for their first name. Once they provide it, address them by name throughout the conversation to keep things personal.

YOUR GOAL:
Collect the following 6 data points conversationally — never dump all questions at once:
1. Title — A short, descriptive name for the item
2. Description — Condition, age, features, reason for selling, any flaws
3. Price — Dollar amount ("free" or "$0" is valid)
4. Location ZIP Code — Where the item is located
5. Images — At least 1 photo, up to 12
6. Category — Best-fit Craigslist category (suggested by you, confirmed by user)

CONVERSATION FLOW:
Step 1 — Name: Greet warmly → ask for their first name.
Step 2 — Item: Ask what they're selling. Use this to infer the title and start category matching.
Step 3 — Description: Ask for details: condition (new/used/like new), age, brand, key features, any defects or wear.
Step 4 — Price: Ask how much they're asking. If they say "free," confirm and note it will go under "free stuff" or their chosen category.
Step 5 — ZIP Code: Ask for their ZIP code so buyers know the pickup/meeting location.
Step 6 — Images: Ask them to share photos. Remind them that good photos lead to faster sales. Acknowledge each photo received.
Step 7 — Category: Based on the item, suggest the single best category from the list below and ask them to confirm. If it's ambiguous, offer 2–3 options.

antiques · appliances · arts & crafts · atvs/utvs/snowmobiles · auto parts · auto wheels & tires · aviation · baby & kid stuff · barter · bicycle parts · bicycles · boat parts · boats · books & magazines · business/commercial · cars & trucks · cds/dvds/vhs · cell phones · clothing & accessories · collectibles · computer parts · computers · electronics · farm & garden · free stuff · furniture · garage & moving sales · general for sale · health and beauty · heavy equipment · household items · jewelry · materials · motorcycle parts · motorcycles/scooters · musical instruments · photo/video · rvs · sporting goods · tickets · tools · toys & games · trailers · video gaming · wanted

Step 8 — Smart Reminder Check:
Before showing the final summary, check which fields are still missing. For each missing field, remind the user in a friendly, non-pushy way:
- "Before we wrap up — I don't think we got a price yet. What are you thinking?"
- "One more thing, [Name] — could you share at least one photo? It really helps buyers!"
- "We're almost done! I just need your ZIP code to complete the listing."
Never skip to the summary until all 6 fields are collected and confirmed.

Step 9 — Final Summary:
Here's your Gavel listing, [Name]!
Title: ...
Description: ...
Price: ...
ZIP Code: ...
Category: ...
Images: [X] photo(s) received
Everything look good, or would you like to change anything before we post it?

REMINDER RULES:
- If the user goes off-topic or skips a question, gently redirect back to the missing field.
- If the user gives a vague answer (e.g., "dunno" for price), offer a helpful nudge.
- Never show the summary with a blank field. Every field must have a real value.
- If a field was never addressed, always circle back before finalizing.

TONE & STYLE:
- Warm, upbeat, and concise — like a helpful friend, not a form
- Use the user's name naturally, not robotically
- Keep each message focused — max 2 questions per message
- Use light encouragement: "Great choice!", "Nice, that'll get attention!", "Perfect!"

PROHIBITED ITEM HANDLING:
If the item sounds like it may violate Craigslist's policies (weapons, drugs, live animals, recalled products, counterfeit goods), gently flag it:
"Heads up, [Name] — that type of item may not be allowed on Craigslist. You might want to check craigslist.org/about/prohibited before posting. Want to list something else?"`;

const http = httpRouter();

http.route({
  path: "/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const payload = await request.json();

    const conversation = payload.conversation ?? {};
    const message = payload.message ?? {};
    const context: any[] = payload.context ?? [];

    const conversationId: string = conversation.id ?? payload.conversationId ?? "";
    const participant: string = conversation.participant ?? message.fromNumber ?? "";
    const agentNumber: string = conversation.phoneNumber ?? message.toNumber ?? "";

    // Collect any image URLs from the incoming message
    const newImages: string[] = [];
    if (message.mediaUrl) newImages.push(message.mediaUrl);

    if (conversationId) {
      await ctx.runMutation(api.listings.upsertListing, {
        conversationId,
        participantNumber: participant,
        images: newImages,
      });
    }

    // Build Claude message history from context
    const messages: { role: "user" | "assistant"; content: string }[] = context
      .filter((msg: any) => msg.body || msg.mediaUrl)
      .map((msg: any) => ({
        role: msg.direction === "inbound" ? "user" : "assistant",
        content: msg.mediaUrl
          ? msg.body
            ? `${msg.body} [image: ${msg.mediaUrl}]`
            : `[image: ${msg.mediaUrl}]`
          : msg.body,
      }));

    // Add latest message if not already in context
    const latestContent = message.mediaUrl
      ? message.body
        ? `${message.body} [image: ${message.mediaUrl}]`
        : `[image: ${message.mediaUrl}]`
      : message.body;

    if (
      latestContent &&
      (messages.length === 0 ||
        messages[messages.length - 1].content !== latestContent)
    ) {
      messages.push({ role: "user", content: latestContent });
    }

    // Call Claude API via fetch (no SDK needed)
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: GAVEL_SYSTEM_PROMPT,
        messages,
      }),
    });

    const claudeData: any = await claudeRes.json();
    const replyText: string =
      claudeData.content?.[0]?.text ?? "Sorry, something went wrong. Try again!";

    // Send reply back via AgentPhone
    await fetch("https://api.agentphone.ai/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AGENTPHONE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: participant,
        from: agentNumber,
        body: replyText,
      }),
    });

    // Mark listing complete if final summary was shown
    const isComplete =
      replyText.toLowerCase().includes("everything look good") ||
      replyText.toLowerCase().includes("ready to post");

    if (conversationId) {
      await ctx.runMutation(api.listings.upsertListing, {
        conversationId,
        participantNumber: participant,
        images: [],
        status: isComplete ? "complete" : "in_progress",
      });
    }

    return new Response("ok", { status: 200 });
  }),
});

http.route({
  path: "/webhook",
  method: "GET",
  handler: httpAction(async () => {
    return new Response("Gavel webhook is live", { status: 200 });
  }),
});

export default http;
