import { useEffect, useRef, useState } from 'react';
import { sessionClient } from '../session';
import { uid } from '../session/events';
import { Modal } from './Modal';

interface Props {
    open: boolean;
    onClose: () => void;
}

interface LogsResult {
    lines: string[];
    logPath: string;
}

/**
 * CLI logs viewer. Re-fetches on every open so the user always sees the
 * latest tail without an explicit refresh control. Used from both the chat
 * header and the settings page.
 */
export function LogsModal({ open, onClose }: Props) {
    const [lines, setLines] = useState<string[]>([]);
    const [path, setPath] = useState('');
    const [loading, setLoading] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);

    // setLoading(true) is intentional here: when the modal opens we flip
    // into the loading state synchronously so the spinner shows on the same
    // paint as the modal itself, before the network round-trip starts.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const res = await sessionClient.rpc(uid(), 'getLogs', { lines: 300 });
                if (cancelled) return;
                const r = res.result as LogsResult | undefined;
                setLines(r?.lines ?? [res.error ?? 'Error fetching logs']);
                setPath(r?.logPath ?? '');
            } catch (e) {
                if (cancelled) return;
                setLines([`Failed: ${e instanceof Error ? e.message : String(e)}`]);
            } finally {
                if (!cancelled) {
                    setLoading(false);
                    setTimeout(() => bottomRef.current?.scrollIntoView(), 100);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [open]);
    /* eslint-enable react-hooks/set-state-in-effect */

    return (
        <Modal open={open} title="CLI Logs" onClose={onClose} size="lg" bare ariaLabel="CLI Logs">
            <div className="logs-modal-card">
                <div className="logs-header">
                    <div className="logs-title-group">
                        <div className="logs-title">CLI 日志</div>
                        {path && <div className="logs-path">{path}</div>}
                    </div>
                    <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭日志">
                        ✕
                    </button>
                </div>
                <div className="logs-body">
                    {loading
                        ? <div className="logs-loading">加载中…</div>
                        : lines.length === 0
                            ? <div className="logs-empty">暂无日志。</div>
                            : lines.map((line, i) => <div key={i} className="logs-line">{line}</div>)
                    }
                    <div ref={bottomRef} />
                </div>
            </div>
        </Modal>
    );
}
