import React, { useState, memo } from 'react';
import { View, Text, TextInput, ScrollView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { decodeBase64 } from '@/encryption/base64';
import { authGetToken } from '@/auth/authGetToken';
import { normalizeSecretKey } from '@/auth/secretKeyBackup';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { directSocket, type DirectQRPayload } from '@/sync/directSocket';
import { TokenStorage } from '@/auth/tokenStorage';
import { useHappyAction } from '@/hooks/useHappyAction';

function getOrCreateWebappPublicKey(): string {
    if (Platform.OS !== 'web') return '';
    const KEY = 'webapp_identity';
    let id = localStorage.getItem(KEY);
    if (!id) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        localStorage.setItem(KEY, id);
    }
    return id;
}

export default memo(function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();

    const [restoreKey, setRestoreKey] = useState('');
    const [directJson, setDirectJson] = useState('');

    const [restoreLoading, handleRestore] = useHappyAction(async () => {
        const trimmed = restoreKey.trim();
        if (!trimmed) {
            Modal.alert('Error', 'Please enter your secret key.');
            return;
        }

        let secretBase64: string;
        try {
            secretBase64 = normalizeSecretKey(trimmed);
        } catch {
            Modal.alert('Error', 'Invalid secret key format. Please check and try again.');
            return;
        }

        const secretBytes = decodeBase64(secretBase64, 'base64url');
        const token = await authGetToken(secretBytes);
        await auth.login(token, secretBase64);
        router.back();
    });

    const [directConnecting, handleDirectConnect] = useHappyAction(async () => {
        if (Platform.OS !== 'web') return;

        const trimmed = directJson.trim();
        if (!trimmed) {
            Modal.alert('Error', 'Please paste the JSON payload from the CLI terminal.');
            return;
        }

        let payload: DirectQRPayload;
        try {
            payload = JSON.parse(trimmed) as DirectQRPayload;
        } catch {
            Modal.alert('Error', 'Invalid JSON — paste the full payload from the CLI terminal.');
            return;
        }

        if (payload.type !== 'direct') {
            Modal.alert('Error', 'This payload is not a direct-connect payload (type must be "direct").');
            return;
        }

        if (Date.now() > payload.nonceExpiry) {
            Modal.alert('Error', 'This payload has expired. Run `happy serve` again to generate a fresh one.');
            return;
        }

        const webappPublicKey = getOrCreateWebappPublicKey();

        await new Promise<void>((resolve, reject) => {
            const cleanup = directSocket.onStatusChange((status) => {
                if (status === 'connected') {
                    cleanup();
                    resolve();
                } else if (status === 'error') {
                    cleanup();
                    reject(new Error('Connection failed — check that the CLI server is reachable.'));
                }
            });
            directSocket.connectFirstTime(payload, webappPublicKey);
        });

        router.push('/direct');
    });

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>

                {/* Secret key restore */}
                <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingTop: 32, paddingBottom: 8 }}>
                    <Text style={styles.sectionTitle}>Restore with Secret Key</Text>
                    <Text style={styles.sectionSubtitle}>
                        Enter your backup secret key to restore your account.
                    </Text>
                    <TextInput
                        style={[styles.input, { color: theme.colors.input.text }]}
                        placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                        placeholderTextColor={theme.colors.textSecondary}
                        value={restoreKey}
                        onChangeText={setRestoreKey}
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                    />
                    <RoundButton
                        title={restoreLoading ? 'Restoring…' : 'Restore Account'}
                        onPress={handleRestore}
                        disabled={restoreLoading || !restoreKey.trim()}
                        loading={restoreLoading}
                    />
                </View>

                {/* Direct Connect section — web only */}
                {Platform.OS === 'web' && (
                    <>
                        <View style={styles.divider} />
                        <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingBottom: 40 }}>
                            <Text style={styles.sectionTitle}>Connect Directly to CLI</Text>
                            <Text style={styles.sectionSubtitle}>
                                Run <Text style={{ fontFamily: 'IBMPlexMono-Regular' }}>happy serve --claude</Text> on your machine, then paste the JSON payload shown in the terminal below.
                            </Text>
                            <TextInput
                                style={[styles.input, styles.multilineInput, { color: theme.colors.input.text }]}
                                placeholder='{"type":"direct","endpoint":"ws://...","nonce":"...",...}'
                                placeholderTextColor={theme.colors.textSecondary}
                                value={directJson}
                                onChangeText={setDirectJson}
                                multiline
                                autoCapitalize="none"
                                autoCorrect={false}
                                spellCheck={false}
                            />
                            <RoundButton
                                title={directConnecting ? 'Connecting…' : 'Connect to CLI'}
                                onPress={handleDirectConnect}
                                disabled={directConnecting || !directJson.trim()}
                                loading={directConnecting}
                            />
                        </View>
                    </>
                )}
            </View>
        </ScrollView>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    sectionSubtitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 16,
        lineHeight: 20,
        ...Typography.default(),
    },
    input: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 16,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 13,
    },
    multilineInput: {
        minHeight: 80,
        textAlignVertical: 'top',
    },
    divider: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginVertical: 32,
        width: '100%',
    },
}));
