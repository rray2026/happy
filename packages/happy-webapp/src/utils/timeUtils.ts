export function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
}

export function groupByDay<T>(items: T[], getTime: (item: T) => number): Array<{ label: string; items: T[] }> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;

    const groups = new Map<string, T[]>();

    for (const item of items) {
        const time = getTime(item);
        const date = new Date(time);
        const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

        let label: string;
        if (day === today) {
            label = 'Today';
        } else if (day === yesterday) {
            label = 'Yesterday';
        } else {
            const daysAgo = Math.floor((today - day) / 86400000);
            label = `${daysAgo} days ago`;
        }

        if (!groups.has(label)) groups.set(label, []);
        groups.get(label)!.push(item);
    }

    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}
