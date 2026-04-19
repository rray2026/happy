import React, { memo, useState } from 'react';
import { Header } from '@/components/layout/Header';
import { Item } from '@/components/ui/Item';
import { ItemGroup } from '@/components/ui/ItemGroup';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/auth/AuthContext';
import { useProfile } from '@/sync/storage';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
import { Modal } from '@/modal/ModalManager';

export const AccountSettingsPage = memo(function AccountSettingsPage() {
    const { logout, credentials } = useAuth();
    const profile = useProfile();
    const [showSecret, setShowSecret] = useState(false);

    const formattedKey = credentials?.secret
        ? formatSecretKeyForBackup(credentials.secret)
        : null;

    const handleLogout = () => {
        Modal.confirm(
            'Sign Out',
            'Are you sure you want to sign out? Make sure you have backed up your secret key first.',
            () => { logout(); },
        );
    };

    const displayName = [profile.firstName, profile.lastName].filter(Boolean).join(' ')
        || profile.github?.name
        || profile.github?.login
        || 'Unknown';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
            <Header title="Account" showBack />
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <ItemGroup title="Profile">
                    <Item title="Display Name" detail={displayName} />
                    {profile.github?.login && <Item title="GitHub" detail={`@${profile.github.login}`} />}
                </ItemGroup>

                <ItemGroup title="Secret Key Backup" footer="Store your secret key securely. It's the only way to recover your account.">
                    {formattedKey ? (
                        <>
                            {showSecret ? (
                                <div style={{ padding: '12px 16px' }}>
                                    <div style={{
                                        fontFamily: 'IBMPlexMono, monospace', fontSize: 13,
                                        color: 'var(--color-text)', letterSpacing: '0.05em',
                                        wordBreak: 'break-all', lineHeight: 1.8,
                                    }}>
                                        {formattedKey}
                                    </div>
                                    <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => { navigator.clipboard.writeText(formattedKey); }}
                                        >
                                            Copy
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setShowSecret(false)}
                                        >
                                            Hide
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <Item
                                    title="Show Secret Key"
                                    icon="🔑"
                                    chevron
                                    onPress={() => setShowSecret(true)}
                                />
                            )}
                        </>
                    ) : (
                        <Item title="No secret key available" />
                    )}
                </ItemGroup>

                <ItemGroup>
                    <Item
                        title="Sign Out"
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </div>
        </div>
    );
});
