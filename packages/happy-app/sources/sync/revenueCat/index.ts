// Stub — RevenueCat removed.
import type { CustomerInfo } from './types';

export enum LogLevel {
    VERBOSE = 'VERBOSE',
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR',
}

export enum PaywallResult {
    PURCHASED = 'PURCHASED',
    RESTORED = 'RESTORED',
    CANCELLED = 'CANCELLED',
    NOT_PRESENTED = 'NOT_PRESENTED',
    ERROR = 'ERROR',
}

const noopCustomerInfo: CustomerInfo = { entitlements: { active: {} } };

export const RevenueCat = {
    setLogLevel(_level: LogLevel): void {},
    configure(_opts: { apiKey: string; appUserId?: string }): void {},
    async getCustomerInfo(): Promise<CustomerInfo> { return noopCustomerInfo; },
    async syncPurchases(): Promise<CustomerInfo> { return noopCustomerInfo; },
    async getProducts(_ids: string[]): Promise<unknown[]> { return []; },
    async purchaseStoreProduct(_product: unknown): Promise<{ customerInfo: CustomerInfo }> {
        throw new Error('Purchases not supported');
    },
    async getOfferings(): Promise<{ current: unknown; all: Record<string, unknown> }> { return { current: null, all: {} }; },
    async presentPaywall(_opts?: unknown): Promise<PaywallResult> { return PaywallResult.NOT_PRESENTED; },
};
