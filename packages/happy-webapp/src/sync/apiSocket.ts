import { io, Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

class ApiSocket {
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private messageHandlers: Map<string, (data: unknown) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
    private currentStatus: ConnectionStatus = 'disconnected';

    initialize(config: SyncSocketConfig) {
        this.config = config;
        this.connect();
    }

    connect() {
        if (!this.config || this.socket) return;
        this.updateStatus('connecting');

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: { token: this.config.token, clientType: 'user-scoped' as const },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity,
        });

        this.socket.on('connect', () => {
            this.updateStatus('connected');
            this.reconnectedListeners.forEach(l => l());
        });

        this.socket.on('disconnect', () => this.updateStatus('disconnected'));
        this.socket.on('connect_error', () => this.updateStatus('error'));

        this.messageHandlers.forEach((handler, event) => {
            this.socket!.on(event, handler);
        });
    }

    disconnect() {
        this.socket?.disconnect();
        this.socket = null;
        this.updateStatus('disconnected');
    }

    private updateStatus(status: ConnectionStatus) {
        this.currentStatus = status;
        this.statusListeners.forEach(l => l(status));
    }

    onReconnected(listener: () => void) {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    }

    onStatusChange(listener: (status: ConnectionStatus) => void) {
        this.statusListeners.add(listener);
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    }

    onMessage(event: string, handler: (data: unknown) => void) {
        this.messageHandlers.set(event, handler);
        this.socket?.on(event, handler);
        return () => {
            this.messageHandlers.delete(event);
            this.socket?.off(event, handler);
        };
    }

    send(event: string, data: unknown) {
        this.socket?.emit(event, data);
    }

    async emitWithAck<T = unknown>(event: string, data: unknown): Promise<T> {
        if (!this.socket) throw new Error('Socket not connected');
        return await this.socket.emitWithAck(event, data) as T;
    }

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) throw new Error('ApiSocket not initialized');
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) throw new Error('No authentication credentials');
        return fetch(`${this.config.endpoint}${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${credentials.token}`, ...options?.headers },
        });
    }

    getStatus(): ConnectionStatus {
        return this.currentStatus;
    }
}

export const apiSocket = new ApiSocket();
