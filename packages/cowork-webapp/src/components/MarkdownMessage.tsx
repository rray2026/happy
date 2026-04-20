import { useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ breaks: true });

interface Props { text: string; }

export function MarkdownMessage({ text }: Props) {
    const html = useMemo(() => marked.parse(text) as string, [text]);
    return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
