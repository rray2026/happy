import React, { memo, useEffect, useRef } from 'react';
import { MessageView } from './MessageView';
import { ChatInput } from './ChatInput';
import { Spinner } from '@/components/ui/Spinner';

interface Message {
    id: string;
    role: string;
    content: unknown;
    createdAt: number;
}

interface ChatViewProps {
    messages: Message[];
    isLoaded: boolean;
    thinking?: boolean;
    onSend: (text: string) => void;
    disabled?: boolean;
    enterToSend?: boolean;
    header?: React.ReactNode;
}

export const ChatView = memo(function ChatView({
    messages, isLoaded, thinking, onSend, disabled, enterToSend, header,
}: ChatViewProps) {
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {header}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                {!isLoaded ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                        <Spinner />
                    </div>
                ) : messages.length === 0 ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', fontSize: 14 }}>
                        No messages yet
                    </div>
                ) : (
                    <>
                        {messages.map(msg => (
                            <MessageView key={msg.id} message={msg} />
                        ))}
                        {thinking && (
                            <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                                <ThinkingDots />
                            </div>
                        )}
                        <div ref={bottomRef} />
                    </>
                )}
            </div>
            <ChatInput onSend={onSend} disabled={disabled} enterToSend={enterToSend} />
        </div>
    );
});

function ThinkingDots() {
    return (
        <div style={{ display: 'flex', gap: 4, padding: '4px 0' }}>
            {[0, 1, 2].map(i => (
                <div key={i} style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: 'var(--color-text-secondary)',
                    animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
            ))}
            <style>{`@keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }`}</style>
        </div>
    );
}
