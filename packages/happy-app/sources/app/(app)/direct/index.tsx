import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
    View,
    Text,
    TextInput,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    TouchableOpacity,
    Modal,
    ActivityIndicator,
    Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { directSocket, DirectSocketStatus } from '@/sync/directSocket';
import { TokenStorage } from '@/auth/tokenStorage';
import { Ionicons } from '@expo/vector-icons';
import { MarkdownView } from '@/components/markdown/MarkdownView';

// ── Stream-json event types ───────────────────────────────────────────────────

interface ClaudeTextPart {
    type: 'text';
    text: string;
}

interface ClaudeToolUsePart {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
}

interface ClaudeToolResultPart {
    type: 'tool_result';
    tool_use_id: string;
    content: string | unknown[];
}

type ClaudeContentPart = ClaudeTextPart | ClaudeToolUsePart | ClaudeToolResultPart;

interface ClaudeAssistantEvent {
    type: 'assistant';
    message: {
        role: 'assistant';
        content: ClaudeContentPart[];
    };
}

interface ClaudeUserEvent {
    type: 'user';
    message: {
        role: 'user';
        content: string | ClaudeContentPart[];
    };
}

interface ClaudeResultEvent {
    type: 'result';
    subtype: 'success' | 'error';
    result: string;
}

interface ClaudeSystemEvent {
    type: 'system';
    subtype: string;
    session_id?: string;
}

interface PermissionRequestEvent {
    type: 'permission-request';
    permissionId: string;
    toolName: string;
    input: unknown;
}

type ClaudeEvent = ClaudeAssistantEvent | ClaudeUserEvent | ClaudeResultEvent | ClaudeSystemEvent | PermissionRequestEvent | { type: string };

// ── Display item types ────────────────────────────────────────────────────────

type DisplayItem =
    | { kind: 'user'; text: string; id: string }
    | { kind: 'assistant'; text: string; id: string }
    | { kind: 'tool-group'; names: string[]; id: string }
    | { kind: 'result'; text: string; success: boolean; id: string }
    | { kind: 'status'; text: string; id: string };

let itemCounter = 0;
function nextId() {
    return String(++itemCounter);
}

function extractUserText(event: ClaudeUserEvent): string {
    const content = event.message.content;
    if (typeof content === 'string') return content;
    const textPart = content.find((p): p is ClaudeTextPart => p.type === 'text');
    return textPart?.text ?? '';
}

function extractAssistantText(event: ClaudeAssistantEvent): string {
    return event.message.content
        .filter((p): p is ClaudeTextPart => p.type === 'text')
        .map((p) => p.text)
        .join('');
}

function extractToolNames(event: ClaudeAssistantEvent): string[] {
    return event.message.content
        .filter((p): p is ClaudeToolUsePart => p.type === 'tool_use')
        .map((p) => p.name);
}

function eventToItems(event: ClaudeEvent): DisplayItem[] {
    switch (event.type) {
        case 'user': {
            const text = extractUserText(event as ClaudeUserEvent);
            return text ? [{ kind: 'user', text, id: nextId() }] : [];
        }
        case 'assistant': {
            const ae = event as ClaudeAssistantEvent;
            const items: DisplayItem[] = [];
            const text = extractAssistantText(ae);
            if (text) items.push({ kind: 'assistant', text, id: nextId() });
            const toolNames = extractToolNames(ae);
            if (toolNames.length > 0) items.push({ kind: 'tool-group', names: toolNames, id: nextId() });
            return items;
        }
        case 'result': {
            const re = event as ClaudeResultEvent;
            if (re.subtype === 'error') {
                return [{ kind: 'result', text: re.result || 'error', success: false, id: nextId() }];
            }
            return [];
        }
        case 'system': {
            const se = event as ClaudeSystemEvent;
            if (se.session_id) {
                return [{ kind: 'status', text: `Session: ${se.session_id.slice(0, 8)}…`, id: nextId() }];
            }
            return [];
        }
        default:
            return [];
    }
}

// ── Typing indicator ──────────────────────────────────────────────────────────

const TypingIndicator = memo(function TypingIndicator() {
    const dots = [useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current];

    useEffect(() => {
        const animations = dots.map((dot, i) =>
            Animated.loop(
                Animated.sequence([
                    Animated.delay(i * 150),
                    Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
                    Animated.timing(dot, { toValue: 0.3, duration: 300, useNativeDriver: true }),
                    Animated.delay((dots.length - 1 - i) * 150),
                ])
            )
        );
        animations.forEach((a) => a.start());
        return () => animations.forEach((a) => a.stop());
    }, []);

    return (
        <View style={styles.typingRow}>
            {dots.map((dot, i) => (
                <Animated.View key={i} style={[styles.typingDot, { opacity: dot }]} />
            ))}
        </View>
    );
});

// ── Status helpers ────────────────────────────────────────────────────────────

function statusColor(status: DirectSocketStatus): string {
    switch (status) {
        case 'connected': return '#34C759';
        case 'connecting': return '#FF9500';
        case 'error': return '#FF3B30';
        default: return '#8E8E93';
    }
}

function statusLabel(status: DirectSocketStatus): string {
    switch (status) {
        case 'connected': return 'Connected';
        case 'connecting': return 'Connecting…';
        case 'error': return 'Error';
        default: return 'Disconnected';
    }
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default memo(function DirectSessionScreen() {
    const router = useRouter();
    const [status, setStatus] = useState<DirectSocketStatus>(directSocket.getStatus());
    const [items, setItems] = useState<DisplayItem[]>([]);
    const [inputText, setInputText] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const scrollRef = useRef<ScrollView>(null);
    const [logsVisible, setLogsVisible] = useState(false);
    const [logLines, setLogLines] = useState<string[]>([]);
    const [logPath, setLogPath] = useState('');
    const [logsLoading, setLogsLoading] = useState(false);
    const logsScrollRef = useRef<ScrollView>(null);
    const [permissionRequest, setPermissionRequest] = useState<PermissionRequestEvent | null>(null);

    useEffect(() => {
        const unsubStatus = directSocket.onStatusChange(setStatus);
        const unsubMsg = directSocket.onMessage((payload) => {
            if ((payload as PermissionRequestEvent).type === 'permission-request') {
                setPermissionRequest(payload as PermissionRequestEvent);
                return;
            }
            const event = payload as ClaudeEvent;

            // Result event marks end of a turn
            if (event.type === 'result') {
                setIsThinking(false);
            }

            const newItems = eventToItems(event);
            if (newItems.length > 0) {
                setItems((prev) => {
                    const merged = [...prev];
                    for (const item of newItems) {
                        if (item.kind === 'tool-group') {
                            const last = merged[merged.length - 1];
                            if (last?.kind === 'tool-group') {
                                merged[merged.length - 1] = { ...last, names: [...last.names, ...item.names] };
                                continue;
                            }
                        }
                        if (item.kind === 'user') {
                            const last = merged[merged.length - 1];
                            if (last?.kind === 'user' && last.text === item.text) continue;
                        }
                        merged.push(item);
                    }
                    return merged;
                });
            }
        });

        const currentStatus = directSocket.getStatus();
        if (currentStatus === 'disconnected') {
            const creds = TokenStorage.getDirectCredentials();
            if (creds) {
                directSocket.connectFromStored({ ...creds, lastSeq: -1 });
            }
        } else if (currentStatus === 'connected') {
            const id = Math.random().toString(36).slice(2);
            directSocket.rpc(id, 'replay', { fromSeq: -1 }).catch(() => {});
        }

        return () => { unsubStatus(); unsubMsg(); };
    }, []);

    useEffect(() => {
        if (items.length > 0 || isThinking) {
            setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
        }
    }, [items, isThinking]);

    const handleSend = useCallback(() => {
        const text = inputText.trim();
        if (!text || status !== 'connected') return;
        directSocket.sendInput(text);
        setInputText('');
        setIsThinking(true);
        setItems((prev) => [...prev, { kind: 'user', text, id: nextId() }]);
    }, [inputText, status]);

    const handlePermission = useCallback((approved: boolean) => {
        if (!permissionRequest) return;
        const id = Math.random().toString(36).slice(2);
        directSocket.rpc(id, 'permissionResponse', {
            permissionId: permissionRequest.permissionId,
            approved,
        }).catch(() => {});
        setPermissionRequest(null);
    }, [permissionRequest]);

    const handleDisconnect = useCallback(() => {
        directSocket.disconnect();
        TokenStorage.removeDirectCredentials();
        router.back();
    }, [router]);

    const handleOpenLogs = useCallback(async () => {
        setLogsVisible(true);
        setLogsLoading(true);
        try {
            const id = Math.random().toString(36).slice(2);
            const res = await directSocket.rpc(id, 'getLogs', { lines: 300 });
            if (res.result && typeof res.result === 'object') {
                const r = res.result as { lines: string[]; logPath: string };
                setLogLines(r.lines ?? []);
                setLogPath(r.logPath ?? '');
            } else if (res.error) {
                setLogLines([`Error fetching logs: ${res.error}`]);
            }
        } catch (e) {
            setLogLines([`Failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`]);
        } finally {
            setLogsLoading(false);
            setTimeout(() => logsScrollRef.current?.scrollToEnd({ animated: false }), 100);
        }
    }, []);

    return (
        <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            {/* Permission modal */}
            <Modal visible={permissionRequest !== null} animationType="fade" transparent onRequestClose={() => handlePermission(false)}>
                <View style={styles.permOverlay}>
                    <View style={styles.permCard}>
                        <Text style={styles.permTitle}>Permission Request</Text>
                        <Text style={styles.permTool}>{permissionRequest?.toolName}</Text>
                        <ScrollView style={styles.permInputScroll}>
                            <Text style={styles.permInput}>{JSON.stringify(permissionRequest?.input, null, 2)}</Text>
                        </ScrollView>
                        <View style={styles.permActions}>
                            <TouchableOpacity onPress={() => handlePermission(false)} style={[styles.permBtn, styles.permDeny]}>
                                <Text style={[styles.permBtnText, { color: '#FF3B30' }]}>Deny</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => handlePermission(true)} style={[styles.permBtn, styles.permApprove]}>
                                <Text style={[styles.permBtnText, { color: '#34C759' }]}>Approve</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* Logs modal */}
            <Modal visible={logsVisible} animationType="slide" onRequestClose={() => setLogsVisible(false)}>
                <View style={styles.logsModal}>
                    <View style={styles.logsHeader}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.logsTitle}>CLI Serve Logs</Text>
                            {logPath ? <Text style={styles.logsPath}>{logPath}</Text> : null}
                        </View>
                        <TouchableOpacity onPress={() => setLogsVisible(false)} style={styles.logsClose}>
                            <Ionicons name="close" size={22} color="#8E8E93" />
                        </TouchableOpacity>
                    </View>
                    {logsLoading ? (
                        <View style={styles.logsCenter}><ActivityIndicator size="large" /></View>
                    ) : (
                        <ScrollView ref={logsScrollRef} style={styles.logsScroll} contentContainerStyle={styles.logsContent}>
                            {logLines.length === 0
                                ? <Text style={styles.logsEmpty}>No log entries found.</Text>
                                : logLines.map((line, i) => <Text key={i} style={styles.logsLine}>{line}</Text>)
                            }
                        </ScrollView>
                    )}
                </View>
            </Modal>

            {/* Header */}
            <View style={styles.header}>
                <View style={styles.statusRow}>
                    <View style={[styles.statusDot, { backgroundColor: statusColor(status) }]} />
                    <Text style={styles.statusText}>{statusLabel(status)}</Text>
                </View>
                <View style={styles.headerActions}>
                    {status === 'connected' && (
                        <TouchableOpacity onPress={handleOpenLogs} style={styles.iconBtn}>
                            <Ionicons name="document-text-outline" size={20} color="#8E8E93" />
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={handleDisconnect} style={styles.iconBtn}>
                        <Ionicons name="close-circle-outline" size={20} color="#FF3B30" />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Message list */}
            <ScrollView
                ref={scrollRef}
                style={styles.messageList}
                contentContainerStyle={styles.messageContent}
                keyboardShouldPersistTaps="handled"
            >
                {items.length === 0 && !isThinking && (
                    <Text style={styles.emptyText}>
                        {status === 'connected' ? 'How can I help you today?' : 'Waiting for connection…'}
                    </Text>
                )}
                {items.map((item) => <MessageItem key={item.id} item={item} />)}
                {isThinking && <TypingIndicator />}
            </ScrollView>

            {/* Input bar */}
            <View style={styles.inputBar}>
                <View style={styles.inputContainer}>
                    <TextInput
                        style={styles.textInput}
                        value={inputText}
                        onChangeText={setInputText}
                        placeholder="Message…"
                        placeholderTextColor="#8E8E93"
                        multiline
                        maxLength={4000}
                        returnKeyType="default"
                        editable={status === 'connected' && !isThinking}
                    />
                    <TouchableOpacity
                        onPress={handleSend}
                        disabled={!inputText.trim() || status !== 'connected' || isThinking}
                        style={[styles.sendBtn, (!inputText.trim() || status !== 'connected' || isThinking) && styles.sendBtnDisabled]}
                    >
                        <Ionicons name="arrow-up" size={18} color="#FFF" />
                    </TouchableOpacity>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
});

// ── MessageItem ───────────────────────────────────────────────────────────────

const MessageItem = memo(function MessageItem({ item }: { item: DisplayItem }) {
    switch (item.kind) {
        case 'user':
            return (
                <View style={styles.userRow}>
                    <View style={styles.userBubble}>
                        <Text style={styles.userText}>{item.text}</Text>
                    </View>
                </View>
            );
        case 'assistant':
            return (
                <View style={styles.assistantRow}>
                    <MarkdownView markdown={item.text} />
                </View>
            );
        case 'tool-group':
            return <ToolGroupItem names={item.names} />;
        case 'result':
            return (
                <View style={[styles.resultRow, item.success ? styles.resultSuccess : styles.resultError]}>
                    <Ionicons
                        name={item.success ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                        size={13}
                        color={item.success ? '#34C759' : '#FF3B30'}
                    />
                    <Text style={[styles.resultText, { color: item.success ? '#34C759' : '#FF3B30' }]}>
                        {item.text}
                    </Text>
                </View>
            );
        case 'status':
            return <Text style={styles.statusMeta}>{item.text}</Text>;
    }
});

// ── ToolGroupItem ─────────────────────────────────────────────────────────────

const ToolGroupItem = memo(function ToolGroupItem({ names }: { names: string[] }) {
    const [collapsed, setCollapsed] = useState(true);
    const label = names.length === 1 ? names[0] : `${names.length} tool calls`;
    return (
        <TouchableOpacity onPress={() => setCollapsed((c) => !c)} activeOpacity={0.7} style={styles.toolGroup}>
            <View style={styles.toolGroupHeader}>
                <Ionicons name="construct-outline" size={13} color="#8E8E93" />
                <Text style={styles.toolGroupLabel}>{label}</Text>
                <Ionicons name={collapsed ? 'chevron-forward' : 'chevron-down'} size={12} color="#8E8E93" />
            </View>
            {!collapsed && names.length > 1 && names.map((name, i) => (
                <View key={i} style={styles.toolGroupRow}>
                    <Text style={styles.toolText}>{name}</Text>
                </View>
            ))}
        </TouchableOpacity>
    );
});

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create((theme) => ({
    flex: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },

    // Header
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.header.background,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    statusText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '500',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    iconBtn: {
        padding: 6,
    },

    // Messages
    messageList: {
        flex: 1,
    },
    messageContent: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 8,
        gap: 16,
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 16,
        textAlign: 'center',
        marginTop: 60,
        fontWeight: '500',
    },
    userRow: {
        alignItems: 'flex-end',
    },
    userBubble: {
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 10,
        maxWidth: '80%',
    },
    userText: {
        color: theme.colors.button.primary.tint,
        fontSize: 16,
        lineHeight: 22,
    },
    assistantRow: {
        alignSelf: 'stretch',
    },
    toolGroup: {
        paddingLeft: 4,
        paddingVertical: 2,
    },
    toolGroupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    toolGroupLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'IBMPlexMono-Regular',
        flex: 1,
    },
    toolGroupRow: {
        paddingLeft: 17,
        paddingTop: 2,
    },
    toolText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'IBMPlexMono-Regular',
    },
    resultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        alignSelf: 'flex-start',
    },
    resultSuccess: {
        backgroundColor: 'rgba(52,199,89,0.1)',
    },
    resultError: {
        backgroundColor: 'rgba(255,59,48,0.1)',
    },
    resultText: {
        fontSize: 12,
        fontFamily: 'IBMPlexMono-Regular',
    },
    statusMeta: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        fontFamily: 'IBMPlexMono-Regular',
    },

    // Typing indicator
    typingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: 8,
        paddingHorizontal: 4,
    },
    typingDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.textSecondary,
    },

    // Input bar
    inputBar: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        paddingBottom: Platform.OS === 'ios' ? 16 : 10,
        backgroundColor: theme.colors.surface,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        backgroundColor: theme.colors.input.background,
        borderRadius: 24,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 8,
    },
    textInput: {
        flex: 1,
        fontSize: 16,
        color: theme.colors.text,
        maxHeight: 140,
        paddingVertical: 4,
    },
    sendBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: theme.colors.button.primary.background,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 2,
    },
    sendBtnDisabled: {
        opacity: 0.35,
    },

    // Permission modal
    permOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
    },
    permCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        padding: 20,
        width: '100%',
        maxWidth: 400,
        gap: 12,
    },
    permTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text,
    },
    permTool: {
        fontSize: 14,
        color: theme.colors.text,
        fontFamily: 'IBMPlexMono-Regular',
        backgroundColor: theme.colors.input.background,
        padding: 8,
        borderRadius: 8,
    },
    permInputScroll: {
        maxHeight: 150,
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
    },
    permInput: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        fontFamily: 'IBMPlexMono-Regular',
        padding: 8,
    },
    permActions: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 4,
    },
    permBtn: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        alignItems: 'center',
    },
    permDeny: {
        backgroundColor: 'rgba(255,59,48,0.15)',
    },
    permApprove: {
        backgroundColor: 'rgba(52,199,89,0.15)',
    },
    permBtnText: {
        fontSize: 15,
        fontWeight: '600',
    },

    // Logs modal
    logsModal: {
        flex: 1,
        backgroundColor: '#0D0D0D',
    },
    logsHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: 16,
        paddingTop: 56,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#2C2C2E',
    },
    logsTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: '#FFFFFF',
    },
    logsPath: {
        fontSize: 11,
        color: '#636366',
        fontFamily: 'IBMPlexMono-Regular',
        marginTop: 2,
    },
    logsClose: {
        padding: 4,
    },
    logsCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logsScroll: {
        flex: 1,
    },
    logsContent: {
        padding: 12,
        gap: 2,
    },
    logsEmpty: {
        color: '#636366',
        fontSize: 13,
        textAlign: 'center',
        marginTop: 40,
    },
    logsLine: {
        fontSize: 11,
        color: '#E5E5EA',
        fontFamily: 'IBMPlexMono-Regular',
        lineHeight: 16,
    },
}));
