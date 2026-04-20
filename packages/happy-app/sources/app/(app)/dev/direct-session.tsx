import * as React from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { TokenStorage, type DirectCredentials } from '@/auth/tokenStorage';
import { Modal } from '@/modal';
import { useRouter } from 'expo-router';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';

export default React.memo(function DirectSessionDevScreen() {
    const router = useRouter();
    const [exportJson, setExportJson] = React.useState<string | null>(null);
    const [importText, setImportText] = React.useState('');

    const handleExport = React.useCallback(() => {
        if (Platform.OS !== 'web') {
            Modal.alert('Web only', 'Direct session is a web-only feature.');
            return;
        }
        const creds = TokenStorage.getDirectCredentials();
        if (!creds) {
            Modal.alert('No session', 'No active direct session found in this browser.');
            return;
        }
        setExportJson(JSON.stringify(creds, null, 2));
    }, []);

    const handleCopy = React.useCallback(async () => {
        if (!exportJson) return;
        await Clipboard.setStringAsync(exportJson);
        Modal.alert('Copied', 'Session JSON copied to clipboard.');
    }, [exportJson]);

    const handleImport = React.useCallback(() => {
        if (Platform.OS !== 'web') {
            Modal.alert('Web only', 'Direct session is a web-only feature.');
            return;
        }
        const text = importText.trim();
        if (!text) {
            Modal.alert('Empty', 'Paste the session JSON first.');
            return;
        }
        let creds: DirectCredentials;
        try {
            creds = JSON.parse(text) as DirectCredentials;
        } catch {
            Modal.alert('Invalid JSON', 'Could not parse the pasted text as JSON.');
            return;
        }
        if (!creds.endpoint || !creds.sessionCredential || !creds.webappPublicKey) {
            Modal.alert('Invalid session', 'Missing required fields (endpoint, sessionCredential, webappPublicKey).');
            return;
        }
        TokenStorage.setDirectCredentials({ ...creds, lastSeq: creds.lastSeq ?? -1 });
        setImportText('');
        Modal.alert('Imported', 'Session imported. Navigate to Direct Connect to reconnect.', [
            { text: 'Go to Direct Connect', onPress: () => router.push('/direct') },
            { text: 'Stay', style: 'cancel' },
        ]);
    }, [importText, router]);

    return (
        <ItemList>
            <ItemGroup title="Export Session" footer="Copy the JSON and paste it in another browser to resume the session.">
                <View style={styles.card}>
                    <TouchableOpacity style={styles.actionBtn} onPress={handleExport}>
                        <Ionicons name="download-outline" size={18} color="#007AFF" />
                        <Text style={styles.actionBtnText}>Load current session</Text>
                    </TouchableOpacity>
                    {exportJson && (
                        <View style={styles.jsonBox}>
                            <ScrollView style={styles.jsonScroll} horizontal={false}>
                                <Text style={styles.jsonText} selectable>{exportJson}</Text>
                            </ScrollView>
                            <TouchableOpacity style={styles.copyBtn} onPress={handleCopy}>
                                <Ionicons name="copy-outline" size={16} color="#FFF" />
                                <Text style={styles.copyBtnText}>Copy to clipboard</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            </ItemGroup>

            <ItemGroup title="Import Session" footer="Paste the session JSON exported from another browser.">
                <View style={styles.card}>
                    <TextInput
                        style={styles.importInput}
                        value={importText}
                        onChangeText={setImportText}
                        placeholder='Paste session JSON here…'
                        placeholderTextColor="#8E8E93"
                        multiline
                        autoCorrect={false}
                        autoCapitalize="none"
                    />
                    <TouchableOpacity
                        style={[styles.actionBtn, styles.importBtn]}
                        onPress={handleImport}
                        disabled={!importText.trim()}
                    >
                        <Ionicons name="log-in-outline" size={18} color="#34C759" />
                        <Text style={[styles.actionBtnText, { color: '#34C759' }]}>Import & connect</Text>
                    </TouchableOpacity>
                </View>
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    actionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    actionBtnText: {
        fontSize: 15,
        color: '#007AFF',
        fontWeight: '500',
    },
    importBtn: {
        marginTop: 4,
    },
    jsonBox: {
        gap: 8,
    },
    jsonScroll: {
        maxHeight: 200,
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        padding: 10,
    },
    jsonText: {
        fontSize: 11,
        color: theme.colors.text,
        fontFamily: 'IBMPlexMono-Regular',
        lineHeight: 16,
    },
    copyBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        backgroundColor: '#007AFF',
        borderRadius: 10,
        paddingVertical: 10,
    },
    copyBtnText: {
        fontSize: 14,
        color: '#FFF',
        fontWeight: '600',
    },
    importInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        padding: 10,
        fontSize: 11,
        color: theme.colors.text,
        fontFamily: 'IBMPlexMono-Regular',
        minHeight: 120,
        textAlignVertical: 'top',
    },
}));
