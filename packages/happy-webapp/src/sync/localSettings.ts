import * as z from 'zod';

export const LocalSettingsSchema = z.object({
    debugMode: z.boolean(),
    devModeEnabled: z.boolean(),
    commandPaletteEnabled: z.boolean(),
    themePreference: z.enum(['light', 'dark', 'adaptive']),
    markdownCopyV2: z.boolean(),
    consoleLoggingEnabled: z.boolean(),
    verboseLogging: z.boolean(),
    acknowledgedCliVersions: z.record(z.string(), z.string()),
});

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

export const localSettingsDefaults: LocalSettings = {
    debugMode: false,
    devModeEnabled: false,
    commandPaletteEnabled: false,
    themePreference: 'adaptive',
    markdownCopyV2: false,
    consoleLoggingEnabled: false,
    verboseLogging: false,
    acknowledgedCliVersions: {},
};
Object.freeze(localSettingsDefaults);

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) return { ...localSettingsDefaults };
    return { ...localSettingsDefaults, ...parsed.data };
}

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
