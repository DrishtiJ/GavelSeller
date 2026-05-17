import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const upsertListing = mutation({
  args: {
    conversationId: v.string(),
    participantNumber: v.string(),
    userName: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    price: v.optional(v.string()),
    zipCode: v.optional(v.string()),
    category: v.optional(v.string()),
    images: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("listings")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...(args.userName !== undefined && { userName: args.userName }),
        ...(args.title !== undefined && { title: args.title }),
        ...(args.description !== undefined && { description: args.description }),
        ...(args.price !== undefined && { price: args.price }),
        ...(args.zipCode !== undefined && { zipCode: args.zipCode }),
        ...(args.category !== undefined && { category: args.category }),
        ...(args.images !== undefined && {
          images: [...(existing.images || []), ...args.images].filter(
            (url, i, arr) => arr.indexOf(url) === i
          ),
        }),
        ...(args.status !== undefined && { status: args.status }),
        updatedAt: now,
      });
      return existing._id;
    } else {
      return await ctx.db.insert("listings", {
        conversationId: args.conversationId,
        participantNumber: args.participantNumber,
        userName: args.userName,
        title: args.title,
        description: args.description,
        price: args.price,
        zipCode: args.zipCode,
        category: args.category,
        images: args.images ?? [],
        status: args.status ?? "in_progress",
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});

export const getListings = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("listings").order("desc").take(100);
  },
});
