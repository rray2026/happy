// Stub — relay server API types.
import { z } from 'zod';

export interface ApiMessage {
    id: string;
    seq: number;
    localId?: string | null;
    role: string;
    content: { t: string; c?: string; [key: string]: unknown };
    createdAt: number;
}

export interface ApiEphemeralActivityUpdate {
    id: string;
    type?: string;
    active: boolean;
    thinking: boolean;
    activeAt: number;
}

export const ApiEphemeralUpdateSchema = z.object({
    id: z.string(),
    active: z.boolean(),
    thinking: z.boolean(),
    activeAt: z.number(),
});

export const ApiUpdateContainerSchema = z.object({
    type: z.string().optional(),
    messages: z.array(z.unknown()).optional(),
    sessions: z.array(z.unknown()).optional(),
});
