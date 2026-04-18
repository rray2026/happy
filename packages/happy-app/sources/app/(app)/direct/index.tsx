import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
    View,
    Text,
    TextInput,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { directSocket, DirectSocketStatus } from '@/sync/directSocket';
import { TokenStorage } from '@/auth/tokenStorage';
import { Ionicons } from '@expo/vector-icons';

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

type ClaudeEvent = ClaudeAssistantEvent | ClaudeUserEvent | ClaudeResultEvent | ClaudeSystemEvent | { type: string };

// ── Display item types ────────────────────────────────────────────────────────

type DisplayItem =
    | { kind: 'user'; text: string; id: string }
    | { kind: 'assistant'; text: string; id: string }
    | { kind: 'tool'; name: string; id: string }
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
            if (text) {
                items.push({ kind: 'assistant', text, id: nextId() });
            }
            for (const name of extractToolNames(ae)) {
                items.push({ kind: 'tool', name, id: nextId() });
            }
            return items;
        }
        case 'result': {
            const re = event as ClaudeResultEvent;
            return [{ kind: 'result', text: re.result || re.subtype, success: re.subtype === 'success', id: nextId() }];
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

// ── Status badge ──────────────────────────────────────────────────────────────

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
    const scrollRef = useRef<ScrollView>(null);

    // Subscribe to socket status and messages
    useEffect(() => {
        const unsubStatus = directSocket.onStatusChange(setStatus);
        const unsubMsg = directSocket.onMessage((payload) => {
            const newItems = eventToItems(payload as ClaudeEvent);
            if (newItems.length > 0) {
                setItems((prev) => [...prev, ...newItems]);
            }
        });

        // If not connected, try to reconnect from stored credentials
        if (directSocket.getStatus() === 'disconnected') {
            const creds = TokenStorage.getDirectCredentials();
            if (creds) {
                directSocket.connectFromStored(creds);
            }
        }

        return () => {
            unsubStatus();
            unsubMsg();
        };
    }, []);

    // Auto-scroll to bottom on new items
    useEffect(() => {
        if (items.length > 0) {
            setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
        }
    }, [items]);

    const handleSend = useCallback(() => {
        const text = inputText.trim();
        if (!text || status !== 'connected') return;
        directSocket.sendInput(text);
        setInputText('');
    }, [inputText, status]);

    const handleDisconnect = useCallback(() => {
        directSocket.disconnect();
        TokenStorage.removeDirectCredentials();
        router.back();
    }, [router]);

    return (
        <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.statusRow}>
                    <View style={[styles.statusDot, { backgroundColor: statusColor(status) }]} />
                    <Text style={styles.statusText}>{statusLabel(status)}</Text>
                </View>
                <TouchableOpacity onPress={handleDisconnect} style={styles.disconnectBtn}>
                    <Ionicons name="close-circle-outline" size={22} color="#FF3B30" />
                    <Text style={styles.disconnectText}>Disconnect</Text>
                </TouchableOpacity>
            </View>

            {/* Message list */}
            <ScrollView
                ref={scrollRef}
                style={styles.messageList}
                contentContainerStyle={styles.messageContent}
                keyboardShouldPersistTaps="handled"
            >
                {items.length === 0 && (
                    <Text style={styles.emptyText}>
                        {status === 'connected'
                            ? 'Connected. Type a message below to start.'
                            : 'Waiting for connection…'}
                    </Text>
                )}
                {items.map((item) => <MessageItem key={item.id} item={item} />)}
            </ScrollView>

            {/* Input bar */}
            <View style={styles.inputBar}>
                <TextInput
                    style={styles.textInput}
                    value={inputText}
                    onChangeText={setInputText}
                    placeholder="Message to CLI agent…"
                    placeholderTextColor="#8E8E93"
                    multiline
                    maxLength={4000}
                    returnKeyType="send"
                    onSubmitEditing={handleSend}
                    editable={status === 'connected'}
                />
                <TouchableOpacity
                    onPress={handleSend}
                    disabled={!inputText.trim() || status !== 'connected' || sending}
                    style={[
                        styles.sendBtn,
                        (!inputText.trim() || status !== 'connected') && styles.sendBtnDisabled,
                    ]}
                >
                    <Ionicons name="send" size={18} color="#FFF" />
                </TouchableOpacity>
            </View>
        </KeyboardAvoidingView>
    );
});

// ── MessageItem ────────────────────────────────────────────────────────────────

const MessageItem = memo(function MessageItem({ item }: { item: DisplayItem }) {
    switch (item.kind) {
        case 'user':
            return (
                <View style={styles.userBubble}>
                    <Text style={styles.userText}>{item.text}</Text>
                </View>
            );
        case 'assistant':
            return (
                <View style={styles.assistantBubble}>
                    <Text style={styles.assistantText}>{item.text}</Text>
                </View>
            );
        case 'tool':
            return (
                <View style={styles.toolRow}>
                    <Ionicons name="construct-outline" size={13} color="#8E8E93" />
                    <Text style={styles.toolText}>{item.name}</Text>
                </View>
            );
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

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create((theme) => ({
    flex: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
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
    disconnectBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    disconnectText: {
        fontSize: 14,
        color: '#FF3B30',
    },
    messageList: {
        flex: 1,
    },
    messageContent: {
        padding: 16,
        gap: 8,
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        textAlign: 'center',
        marginTop: 40,
    },
    userBubble: {
        alignSelf: 'flex-end',
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 8,
        maxWidth: '80%',
    },
    userText: {
        color: theme.colors.button.primary.tint,
        fontSize: 15,
    },
    assistantBubble: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.input.background,
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 8,
        maxWidth: '90%',
    },
    assistantText: {
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 22,
    },
    toolRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 4,
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
    inputBar: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        gap: 8,
    },
    textInput: {
        flex: 1,
        backgroundColor: theme.colors.input.background,
        borderRadius: 20,
        paddingHorizontal: 14,
        paddingVertical: 8,
        fontSize: 15,
        color: theme.colors.text,
        maxHeight: 120,
    },
    sendBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: theme.colors.button.primary.background,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendBtnDisabled: {
        opacity: 0.4,
    },
}));
