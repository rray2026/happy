// Stub — feed feature removed.

export interface FeedItem {
    id: string;
    type: string;
    createdAt: number;
    data: unknown;
    repeatKey?: string | null;
    counter: number;
    cursor: string;
}
