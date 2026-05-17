import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  listings: defineTable({
    conversationId: v.string(),
    participantNumber: v.string(),
    userName: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    price: v.optional(v.string()),
    zipCode: v.optional(v.string()),
    category: v.optional(v.string()),
    images: v.array(v.string()),
    status: v.string(), // "in_progress" | "complete"
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_conversation", ["conversationId"]),
});
