import React, { useState, useEffect, useRef, memo } from 'react';
import { View, Text, TextInput, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { encodeBase64 } from '@/encryption/base64';
import { generateAuthKeyPair, authQRStart } from '@/auth/authQRStart';
import { authQRWait } from '@/auth/authQRWait';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { QRCode } from '@/components/qr/QRCode';
import { directSocket, type DirectQRPayload } from '@/sync/directSocket';
import { TokenStorage } from '@/auth/tokenStorage';

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
    secondInstructionText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 20,
        marginTop: 30,
        ...Typography.default(),
    },
    divider: {
        height: 1,
        backgroundColor: theme.colors.border,
        marginVertical: 32,
        width: '100%',
    },
    directTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    directSubtitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 16,
        lineHeight: 20,
        ...Typography.default(),
    },
    directInput: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 16,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 12,
        minHeight: 80,
        textAlignVertical: 'top',
        color: theme.colors.input.text,
    },
}));

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
    const [authReady, setAuthReady] = useState(false);
    const isCancelledRef = useRef(false);

    // Direct connect state
    const [directJson, setDirectJson] = useState('');
    const [directConnecting, setDirectConnecting] = useState(false);

    // Memoize keypair generation to prevent re-creating on re-renders
    const keypair = React.useMemo(() => generateAuthKeyPair(), []);

    // Start QR authentication when component mounts
    useEffect(() => {
        const startQRAuth = async () => {
            try {
                const success = await authQRStart(keypair);
                if (!success) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                    return;
                }

                setAuthReady(true);

                const credentials = await authQRWait(
                    keypair,
                    () => {},
                    () => isCancelledRef.current
                );

                if (credentials && !isCancelledRef.current) {
                    const secretString = encodeBase64(credentials.secret, 'base64url');
                    await auth.login(credentials.token, secretString);
                    if (!isCancelledRef.current) {
                        router.back();
                    }
                } else if (!isCancelledRef.current) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }

            } catch (error) {
                if (!isCancelledRef.current) {
                    console.error('QR Auth error:', error);
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }
            }
        };

        startQRAuth();

        return () => {
            isCancelledRef.current = true;
        };
    }, [keypair]);

    const handleDirectConnect = async () => {
        if (Platform.OS !== 'web') return;

        const trimmed = directJson.trim();
        if (!trimmed) return;

        let payload: DirectQRPayload;
        try {
            payload = JSON.parse(trimmed) as DirectQRPayload;
        } catch {
            Modal.alert('Error', 'Invalid JSON — paste the full payload from the CLI terminal.');
            return;
        }

        if (payload.type !== 'direct') {
            Modal.alert('Error', 'This QR payload is not a direct-connect payload (type must be "direct").');
            return;
        }

        if (Date.now() > payload.nonceExpiry) {
            Modal.alert('Error', 'This payload has expired. Run `happy serve` again to generate a fresh one.');
            return;
        }

        setDirectConnecting(true);
        try {
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
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            Modal.alert('Connection Failed', message);
            directSocket.disconnect();
        } finally {
            setDirectConnecting(false);
        }
    };

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>

                <View style={{justifyContent: 'flex-end' }}>
                    <Text style={styles.secondInstructionText}>
                        1. Open Happy on your mobile device{'\n'}
                        2. Go to Settings → Account{'\n'}
                        3. Tap "Link New Device"{'\n'}
                        4. Scan this QR code
                    </Text>
                </View>
                {!authReady && (
                    <View style={{ width: 200, height: 200, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.text} />
                    </View>
                )}
                {authReady && (
                    <QRCode
                        data={'happy:///account?' + encodeBase64(keypair.publicKey, 'base64url')}
                        size={300}
                        foregroundColor={'black'}
                        backgroundColor={'white'}
                    />
                )}
                <View style={{ flexGrow: 4, paddingTop: 30 }}>
                    <RoundButton title="Restore with Secret Key Instead" display='inverted' onPress={() => {
                        router.push('/restore/manual');
                    }} />
                </View>

                {/* Direct Connect section — web only */}
                {Platform.OS === 'web' && (
                    <>
                        <View style={styles.divider} />
                        <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingBottom: 40 }}>
                            <Text style={styles.directTitle}>Connect Directly to CLI</Text>
                            <Text style={styles.directSubtitle}>
                                Run <Text style={{ fontFamily: 'IBMPlexMono-Regular' }}>happy serve --claude</Text> on your machine, then paste the JSON payload shown in the terminal below.
                            </Text>
                            <TextInput
                                style={styles.directInput}
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
