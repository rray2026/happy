import { useState, useEffect } from 'react';
import { formatLastSeen } from '@/utils/sessionUtils';

export function useElapsedTime(timestamp: number): string {
    const [text, setText] = useState(() => formatLastSeen(timestamp));

    useEffect(() => {
        const id = setInterval(() => setText(formatLastSeen(timestamp)), 30000);
        return () => clearInterval(id);
    }, [timestamp]);

    return text;
}
