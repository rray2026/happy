import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true });

interface Props {
    text: string;
    /**
     * When true, parse + sanitize at most once per animation frame so a fast
     * delta stream doesn't run marked() for every token. The final committed
     * text is rendered synchronously when streaming flips back to false.
     */
    streaming?: boolean;
}

export function MarkdownMessage({ text, streaming = false }: Props) {
    const [displayText, setDisplayText] = useState(text);
    const pendingRef = useRef(text);
    const rafRef = useRef<number | null>(null);

    // Sync setDisplayText below is intentional: when streaming flips to false
    // we want the final markdown rendered in the same paint as everything
    // else (e.g. timestamp, scroll-snap), not one frame later.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        pendingRef.current = text;
        if (!streaming) {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            setDisplayText(text);
            return;
        }
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            setDisplayText(pendingRef.current);
        });
    }, [text, streaming]);
    /* eslint-enable react-hooks/set-state-in-effect */

    useEffect(() => () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    }, []);

    const html = useMemo(() => {
        const raw = marked.parse(displayText) as string;
        return DOMPurify.sanitize(raw);
    }, [displayText]);

    return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
