import React, { memo } from 'react';
import { Header } from '@/components/layout/Header';
import { Item } from '@/components/ui/Item';
import { ItemGroup } from '@/components/ui/ItemGroup';
import { Switch } from '@/components/ui/Switch';
import { useLocalSettings } from '@/sync/storage';
import { useTheme } from '@/theme/ThemeProvider';
import { storage } from '@/sync/storage';
import { applyLocalSettings } from '@/sync/localSettings';
import { saveLocalSettings } from '@/sync/persistence';

export const AppearancePage = memo(function AppearancePage() {
    const localSettings = useLocalSettings();
    const { mode, setMode } = useTheme();

    const setLocalSetting = <K extends keyof typeof localSettings>(key: K, value: typeof localSettings[K]) => {
        const updated = applyLocalSettings(localSettings, { [key]: value });
        storage.getState().setLocalSettings(updated);
        saveLocalSettings(updated);
    };

    const themeOptions: Array<{ value: 'adaptive' | 'light' | 'dark'; label: string }> = [
        { value: 'adaptive', label: 'Automatic' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
            <Header title="Appearance" showBack />
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <ItemGroup title="Theme">
                    {themeOptions.map(opt => (
                        <Item
                            key={opt.value}
                            title={opt.label}
                            right={mode === opt.value ? (
                                <span style={{ color: 'var(--color-primary)', fontSize: 16 }}>✓</span>
                            ) : undefined}
                            onPress={() => {
                                setMode(opt.value);
                                setLocalSetting('themePreference', opt.value);
                            }}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup title="Debug">
                    <Item
                        title="Debug Mode"
                        right={
                            <Switch
                                value={localSettings.debugMode}
                                onValueChange={v => setLocalSetting('debugMode', v)}
                            />
                        }
                    />
                    <Item
                        title="Verbose Logging"
                        right={
                            <Switch
                                value={localSettings.verboseLogging}
                                onValueChange={v => setLocalSetting('verboseLogging', v)}
                            />
                        }
                    />
                </ItemGroup>
            </div>
        </div>
    );
});
