import * as z from 'zod';

export const SUPPORTED_SCHEMA_VERSION = 2;

export const SettingsSchema = z.object({
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION),
    viewInline: z.boolean(),
    inferenceOpenAIKey: z.string().nullish(),
    expandTodos: z.boolean(),
    showLineNumbers: z.boolean(),
    showLineNumbersInToolViews: z.boolean(),
    wrapLinesInDiffs: z.boolean(),
    analyticsOptOut: z.boolean(),
    experiments: z.boolean(),
    alwaysShowContextSize: z.boolean(),
    agentInputEnterToSend: z.boolean(),
    avatarStyle: z.string(),
    showFlavorIcons: z.boolean(),
    compactSessionView: z.boolean(),
    hideInactiveSessions: z.boolean(),
    expResumeSession: z.boolean(),
    reviewPromptAnswered: z.boolean(),
    reviewPromptLikedApp: z.boolean().nullish(),
    voiceAssistantLanguage: z.string().nullable(),
    voiceCustomAgentId: z.string().nullable(),
    voiceBypassToken: z.boolean(),
    preferredLanguage: z.string().nullable(),
    recentMachinePaths: z.array(z.object({ machineId: z.string(), path: z.string() })),
    lastUsedAgent: z.string().nullable(),
    lastUsedPermissionMode: z.string().nullable(),
    lastUsedModelMode: z.string().nullable(),
    dismissedCLIWarnings: z.object({
        perMachine: z.record(z.string(), z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        })).default({}),
        global: z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        }).default({}),
    }).default({ perMachine: {}, global: {} }),
});

const SettingsSchemaPartial = SettingsSchema.partial();

export type Settings = z.infer<typeof SettingsSchema>;

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    viewInline: false,
    inferenceOpenAIKey: null,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: false,
    analyticsOptOut: false,
    experiments: false,
    alwaysShowContextSize: false,
    agentInputEnterToSend: true,
    avatarStyle: 'brutalist',
    showFlavorIcons: false,
    compactSessionView: false,
    hideInactiveSessions: false,
    expResumeSession: false,
    reviewPromptAnswered: false,
    reviewPromptLikedApp: null,
    voiceAssistantLanguage: null,
    voiceCustomAgentId: null,
    voiceBypassToken: false,
    preferredLanguage: null,
    recentMachinePaths: [],
    lastUsedAgent: null,
    lastUsedPermissionMode: null,
    lastUsedModelMode: null,
    dismissedCLIWarnings: { perMachine: {}, global: {} },
};
Object.freeze(settingsDefaults);

export function settingsParse(settings: unknown): Settings {
    if (!settings || typeof settings !== 'object') return { ...settingsDefaults };
    const parsed = SettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) return { ...settingsDefaults };
    if (parsed.data.preferredLanguage === 'zh') parsed.data.preferredLanguage = 'zh-Hans';
    return { ...settingsDefaults, ...parsed.data };
}

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    return { ...settings, ...delta };
}
