import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true });

interface Props { text: string; }

export function MarkdownMessage({ text }: Props) {
    const html = useMemo(() => {
        const raw = marked.parse(text) as string;
        return DOMPurify.sanitize(raw);
    }, [text]);
    return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
