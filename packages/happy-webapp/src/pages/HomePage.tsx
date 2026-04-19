import React, { memo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthContext';
import { useSessionRows } from '@/sync/storage';
import { SessionList } from '@/components/session/SessionList';
import { AppLayout } from '@/components/layout/AppLayout';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { generateAuthKeyPair, authQRStart } from '@/auth/authQRStart';
import { authQRWait } from '@/auth/authQRWait';
import { authGetToken } from '@/auth/authGetToken';
import { encodeBase64 } from '@/encryption/base64';
import { normalizeSecretKey } from '@/auth/secretKeyBackup';
import { decodeBase64 } from '@/encryption/base64';

const LandingPage = memo(function LandingPage() {
    const { login } = useAuth();
    const [mode, setMode] = useState<'idle' | 'qr' | 'restore'>('idle');
    const [qrValue, setQrValue] = useState('');
    const [qrStatus, setQrStatus] = useState('');
    const [secretInput, setSecretInput] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const startQR = async () => {
        setMode('qr');
        setError('');
        const keypair = generateAuthKeyPair();
        const serverUrl = (import.meta.env.VITE_HAPPY_SERVER_URL as string) || 'https://api.cluster-fluster.com';
        const qrData = `${serverUrl}#qr=${encodeBase64(keypair.publicKey)}`;
        setQrValue(qrData);
        setQrStatus('Scan the QR code with your Happy mobile app...');

        const result = await authQRWait(keypair, (dots) => {
            setQrStatus('Waiting' + '.'.repeat((dots % 3) + 1));
        });

        if (result) {
            const token = await authGetToken(result.secret);
            const secretB64 = encodeBase64(result.secret, 'base64url');
            await login(token, secretB64);
        } else {
            setError('QR authentication failed. Please try again.');
            setMode('idle');
        }
    };

    const handleRestore = async () => {
        setError('');
        setLoading(true);
        try {
            const normalized = normalizeSecretKey(secretInput);
            const secretBytes = decodeBase64(normalized, 'base64url');
            const token = await authGetToken(secretBytes);
            await login(token, normalized);
        } catch (e) {
            setError('Invalid secret key. Please check and try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100vh',
            background: 'var(--color-surface)', padding: 24,
        }}>
            <div style={{ maxWidth: 360, width: '100%', textAlign: 'center' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🤖</div>
                <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-text)', margin: '0 0 8px' }}>Happy</h1>
                <p style={{ color: 'var(--color-text-secondary)', fontSize: 15, margin: '0 0 32px' }}>
                    Claude Code & Codex remote control
                </p>

                {mode === 'idle' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <Button onClick={startQR} size="lg" style={{ width: '100%', justifyContent: 'center' }}>
                            Create Account
                        </Button>
                        <Button variant="secondary" onClick={() => { setMode('restore'); setError(''); }} size="lg" style={{ width: '100%', justifyContent: 'center' }}>
                            Link / Restore Account
                        </Button>
                    </div>
                )}

                {mode === 'qr' && (
                    <div>
                        <div style={{
                            background: '#fff', padding: 16, borderRadius: 12, marginBottom: 16,
                            border: '1px solid var(--color-divider)',
                        }}>
                            {/* Simple QR placeholder — real implementation would use a QR library */}
                            <div style={{ fontSize: 12, wordBreak: 'break-all', color: '#000', fontFamily: 'IBMPlexMono, monospace' }}>
                                {qrValue.slice(0, 80)}...
                            </div>
                            <p style={{ fontSize: 11, color: '#666', marginTop: 8 }}>Copy this URL and open it in the Happy mobile app</p>
                        </div>
                        <p style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>{qrStatus}</p>
                        <Button variant="ghost" onClick={() => setMode('idle')} size="sm">Cancel</Button>
                    </div>
                )}

                {mode === 'restore' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <textarea
                            placeholder="Enter your secret key (e.g. AAAAA-BBBBB-...)"
                            value={secretInput}
                            onChange={e => setSecretInput(e.target.value)}
                            rows={3}
                            style={{
                                width: '100%', padding: '10px 14px', borderRadius: 10,
                                border: '1px solid var(--color-divider)',
                                background: 'var(--color-surface-high)', color: 'var(--color-text)',
                                fontSize: 14, fontFamily: 'IBMPlexMono, monospace',
                                resize: 'none', outline: 'none', boxSizing: 'border-box',
                            }}
                        />
                        {error && <p style={{ color: 'var(--color-error)', fontSize: 13, margin: 0 }}>{error}</p>}
                        <Button onClick={handleRestore} loading={loading} size="lg" style={{ width: '100%', justifyContent: 'center' }}>
                            Restore Account
                        </Button>
                        <Button variant="ghost" onClick={() => setMode('idle')} size="sm">Cancel</Button>
                    </div>
                )}
            </div>
        </div>
    );
});

const SessionsHome = memo(function SessionsHome() {
    const sessions = useSessionRows();
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title="Sessions" />
            <SessionList sessions={sessions} emptyMessage="No sessions yet. Start a session from a machine." />
        </div>
    );
});

// Layout route: shows LandingPage when unauth, AppLayout (with Outlet) when auth.
export const AppAuthGate = memo(function AppAuthGate() {
    const { isAuthenticated } = useAuth();
    if (!isAuthenticated) return <LandingPage />;
    return <AppLayout />;
});

export const SessionsIndexPage = memo(function SessionsIndexPage() {
    return <SessionsHome />;
});
