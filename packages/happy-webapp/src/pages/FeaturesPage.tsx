import React, { memo } from 'react';
import { Header } from '@/components/layout/Header';
import { Item } from '@/components/ui/Item';
import { ItemGroup } from '@/components/ui/ItemGroup';
import { Switch } from '@/components/ui/Switch';
import { useSettings } from '@/sync/storage';
import { sync } from '@/sync/sync';

export const FeaturesPage = memo(function FeaturesPage() {
    const settings = useSettings();

    const setSetting = <K extends keyof typeof settings>(key: K, value: typeof settings[K]) => {
        sync.applySettings({ [key]: value } as Parameters<typeof sync.applySettings>[0]);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
            <Header title="Features" showBack />
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <ItemGroup title="Display" footer="Control how messages and code are displayed.">
                    <Item
                        title="Show Line Numbers"
                        right={<Switch value={settings.showLineNumbers} onValueChange={v => setSetting('showLineNumbers', v)} />}
                    />
                    <Item
                        title="Inline Tool Views"
                        right={<Switch value={settings.viewInline} onValueChange={v => setSetting('viewInline', v)} />}
                    />
                    <Item
                        title="Expand Todos"
                        right={<Switch value={settings.expandTodos} onValueChange={v => setSetting('expandTodos', v)} />}
                    />
                    <Item
                        title="Compact Session View"
                        right={<Switch value={settings.compactSessionView} onValueChange={v => setSetting('compactSessionView', v)} />}
                    />
                    <Item
                        title="Hide Inactive Sessions"
                        right={<Switch value={settings.hideInactiveSessions} onValueChange={v => setSetting('hideInactiveSessions', v)} />}
                    />
                </ItemGroup>

                <ItemGroup title="Input">
                    <Item
                        title="Enter to Send"
                        subtitle="Send messages with Enter key"
                        right={<Switch value={settings.agentInputEnterToSend} onValueChange={v => setSetting('agentInputEnterToSend', v)} />}
                    />
                </ItemGroup>

                <ItemGroup title="Experimental">
                    <Item
                        title="Experiments"
                        right={<Switch value={settings.experiments} onValueChange={v => setSetting('experiments', v)} />}
                    />
                    <Item
                        title="Resume Session"
                        right={<Switch value={settings.expResumeSession} onValueChange={v => setSetting('expResumeSession', v)} />}
                    />
                </ItemGroup>

                <ItemGroup title="Privacy">
                    <Item
                        title="Analytics Opt-Out"
                        right={<Switch value={settings.analyticsOptOut} onValueChange={v => setSetting('analyticsOptOut', v)} />}
                    />
                </ItemGroup>
            </div>
        </div>
    );
});
