import * as React from 'react';
import { View, FlatList, TouchableOpacity, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { log } from '@/log';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';

export default React.memo(function ErrorLogsScreen() {
    const { theme } = useUnistyles();
    const [logs, setLogs] = React.useState<string[]>(() => log.getLogs());
    const flatListRef = React.useRef<FlatList>(null);

    React.useEffect(() => {
        const unsub = log.onChange(() => setLogs(log.getLogs()));
        return unsub;
    }, []);

    React.useEffect(() => {
        if (logs.length > 0) {
            setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100);
        }
    }, [logs.length]);

    const handleCopy = async () => {
        if (logs.length === 0) {
            Modal.alert(t('common.error'), 'No logs to copy.');
            return;
        }
        await Clipboard.setStringAsync(logs.join('\n'));
        Modal.alert(t('common.copy'), `${logs.length} entries copied.`);
    };

    const handleClear = async () => {
        const confirmed = await Modal.confirm('Clear Logs', 'Clear all log entries?', {
            confirmText: 'Clear',
            destructive: true,
        });
        if (confirmed) log.clear();
    };

    const errorCount = React.useMemo(
        () => logs.filter(l => l.startsWith('[error]')).length,
        [logs]
    );

    return (
        <View style={styles.container}>
            {/* Toolbar */}
            <View style={[styles.toolbar, { borderBottomColor: theme.colors.divider }]}>
                <Text style={[styles.count, { color: theme.colors.textSecondary }]}>
                    {logs.length} entries{errorCount > 0 ? ` · ${errorCount} errors` : ''}
                </Text>
                <View style={styles.actions}>
                    <TouchableOpacity onPress={handleClear} style={styles.actionBtn} disabled={logs.length === 0}>
                        <Ionicons name="trash-outline" size={18} color={logs.length === 0 ? theme.colors.textSecondary : '#FF3B30'} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleCopy} style={[styles.copyBtn, { backgroundColor: theme.colors.button.primary.background }]} disabled={logs.length === 0}>
                        <Ionicons name="copy-outline" size={16} color={theme.colors.button.primary.tint} />
                        <Text style={[styles.copyText, { color: theme.colors.button.primary.tint }]}>{t('common.copy')}</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {logs.length === 0 ? (
                <View style={styles.empty}>
                    <Ionicons name="checkmark-circle-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No logs yet</Text>
                </View>
            ) : (
                <FlatList
                    ref={flatListRef}
                    data={logs}
                    keyExtractor={(_, i) => String(i)}
                    renderItem={({ item }) => <LogLine line={item} />}
                    contentContainerStyle={styles.listContent}
                    style={styles.list}
                />
            )}
        </View>
    );
});

const LogLine = React.memo(function LogLine({ line }: { line: string }) {
    const { theme } = useUnistyles();
    const isError = line.startsWith('[error]');
    const isWarn = line.startsWith('[warn]');
    return (
        <Text
            style={[
                styles.line,
                { color: isError ? '#FF3B30' : isWarn ? '#FF9500' : theme.colors.text },
            ]}
            selectable
        >
            {line}
        </Text>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
    },
    count: {
        fontSize: 13,
        fontFamily: 'IBMPlexMono-Regular',
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    actionBtn: {
        padding: 4,
    },
    copyBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
    },
    copyText: {
        fontSize: 14,
        fontWeight: '600',
    },
    list: {
        flex: 1,
    },
    listContent: {
        padding: 12,
        gap: 2,
    },
    line: {
        fontSize: 11,
        fontFamily: 'IBMPlexMono-Regular',
        lineHeight: 16,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
    },
    emptyText: {
        fontSize: 15,
    },
}));
