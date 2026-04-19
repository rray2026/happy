import type { Machine } from '@/sync/storageTypes';

export function isMachineOnline(machine: Machine): boolean {
    return machine.active;
}

export function getMachineDisplayName(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id;
}
