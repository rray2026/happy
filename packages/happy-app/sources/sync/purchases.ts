// Stub — in-app purchases/RevenueCat removed.
import type { CustomerInfo } from './revenueCat/types';

export interface Purchases {
    entitlements: Record<string, boolean>;
    originalAppUserId?: string;
}

export const purchasesDefaults: Purchases = {
    entitlements: {},
};

export function purchasesParse(raw: unknown): Purchases {
    if (!raw || typeof raw !== 'object') return { ...purchasesDefaults };
    const r = raw as Record<string, unknown>;
    return {
        entitlements: typeof r.entitlements === 'object' && r.entitlements !== null
            ? (r.entitlements as Record<string, boolean>)
            : {},
    };
}

export function customerInfoToPurchases(_customerInfo: CustomerInfo): Purchases {
    return { ...purchasesDefaults };
}
