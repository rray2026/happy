// Stub — relay server socket removed in direct-connect mode.

class ApiSocket {
    async emitWithAck<T>(_event: string, _data: unknown): Promise<T> {
        throw new Error('Not supported in direct-connect mode');
    }
    async request(_path: string, _opts?: RequestInit): Promise<Response> {
        throw new Error('Not supported in direct-connect mode');
    }
    async sessionRPC<R = unknown, P = unknown>(_sessionId: string, _method: string, _params?: P): Promise<R> {
        throw new Error('Not supported in direct-connect mode');
    }
    async machineRPC<R = unknown, P = unknown>(_machineId: string, _method: string, _params?: P): Promise<R> {
        throw new Error('Not supported in direct-connect mode');
    }
    getStatus(): string { return 'disconnected'; }
    connect(_url: string, _credentials: unknown): void {}
    disconnect(): void {}
}

export const apiSocket = new ApiSocket();
