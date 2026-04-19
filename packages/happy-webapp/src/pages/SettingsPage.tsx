import React, { memo } from 'react';
import { useNavigate } from 'react-router';
import { Header } from '@/components/layout/Header';
import { Item } from '@/components/ui/Item';
import { ItemGroup } from '@/components/ui/ItemGroup';

export const SettingsPage = memo(function SettingsPage() {
    const navigate = useNavigate();

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
            <Header title="Settings" />
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <ItemGroup title="Account">
                    <Item title="Account" icon="👤" chevron onPress={() => navigate('/settings/account')} />
                </ItemGroup>
                <ItemGroup title="Preferences">
                    <Item title="Appearance" icon="🎨" chevron onPress={() => navigate('/settings/appearance')} />
                    <Item title="Features" icon="⚡" chevron onPress={() => navigate('/settings/features')} />
                </ItemGroup>
                <ItemGroup title="Social">
                    <Item title="Friends" icon="👥" chevron onPress={() => navigate('/friends')} />
                    <Item title="Inbox" icon="📬" chevron onPress={() => navigate('/inbox')} />
                    <Item title="Artifacts" icon="📦" chevron onPress={() => navigate('/artifacts')} />
                </ItemGroup>
            </div>
        </div>
    );
});
