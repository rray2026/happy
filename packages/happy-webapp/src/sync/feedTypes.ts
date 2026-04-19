import { z } from 'zod';

export const FeedBodySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('friend_request'), uid: z.string() }),
    z.object({ kind: z.literal('friend_accepted'), uid: z.string() }),
    z.object({ kind: z.literal('text'), text: z.string() }),
]);

export type FeedBody = z.infer<typeof FeedBodySchema>;

export const FeedItemSchema = z.object({
    id: z.string(),
    repeatKey: z.string().nullable(),
    body: FeedBodySchema,
    createdAt: z.number(),
    cursor: z.string(),
    counter: z.number(),
});

export type FeedItem = z.infer<typeof FeedItemSchema>;
