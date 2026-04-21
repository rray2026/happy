import { useCallback, useEffect, useState } from 'react';
import type { ChatSessionMeta } from '../types';
import { sessionClient } from '../session';
import { uid } from '../session/events';
import { Modal } from './Modal';

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (session: ChatSessionMeta) => void;
}

/** Response shape for `fs.listDirs` on the agent. */
interface ListDirsResult {
    root: string;
    relPath: string;
    dirs: string[];
}

interface Crumb {
    label: string;
    rel: string;
}

/**
 * "New session" dialog: pick a tool + model + working directory (which must
 * be a subdirectory of the agent root). The directory picker is a
 * breadcrumb-navigated, single-level list — simple to operate on both mobile
 * and desktop and easy to reason about vs. a full tree.
 */
export function NewSessionModal({ open, onClose, onCreated }: Props) {
    const [tool, setTool] = useState<'claude' | 'gemini'>('claude');
    const [model, setModel] = useState('');
    const [picker, setPicker] = useState<ListDirsResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const browseTo = useCallback(async (rel: string) => {
        setLoading(true);
        setError(null);
        try {
            const res = await sessionClient.rpc(uid(), 'fs.listDirs', { relPath: rel });
            if (res.error) {
                setError(res.error);
                return;
            }
            setPicker(res.result as ListDirsResult);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    // Reset state + load root whenever the modal opens.
    useEffect(() => {
        if (!open) return;
        setTool('claude');
        setModel('');
        setError(null);
        setPicker(null);
        void browseTo('');
    }, [open, browseTo]);

    const handleCreate = async () => {
        setCreating(true);
        setError(null);
        try {
            const params: Record<string, unknown> = { tool };
            const m = model.trim();
            if (m) params.model = m;
            if (picker && picker.relPath) params.cwd = picker.relPath;
            const res = await sessionClient.rpc(uid(), 'session.create', params);
            if (res.error) {
                setError(res.error);
                return;
            }
            const created = (res.result as { session?: ChatSessionMeta } | undefined)?.session;
            if (created) {
                onCreated(created);
                onClose();
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setCreating(false);
        }
    };

    const crumbs: Crumb[] = picker ? buildCrumbs(picker.relPath) : [];
    const rootLabel = picker?.root ? ` (${picker.root})` : '';

    return (
        <Modal open={open} title="新建会话" onClose={onClose} size="md">
            <div className="modal-body new-session-body">
                {/* Tool */}
                <div className="new-session-row">
                    <span className="new-session-label">工具</span>
                    <div className="new-session-tools">
                        <button
                            type="button"
                            className={`btn ${tool === 'claude' ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setTool('claude')}
                        >
                            Claude
                        </button>
                        <button
                            type="button"
                            className={`btn ${tool === 'gemini' ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setTool('gemini')}
                        >
                            Gemini
                        </button>
                    </div>
                </div>

                {/* Model */}
                <label className="new-session-row">
                    <span className="new-session-label">模型</span>
                    <input
                        className="new-session-input"
                        placeholder="可选 — 如 opus、sonnet、gemini-2.5-flash"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        spellCheck={false}
                    />
                </label>

                {/* Directory picker */}
                <div className="new-session-row new-session-row-col">
                    <span className="new-session-label">
                        工作目录
                        <span className="new-session-hint">
                            必须是 agent 启动目录{rootLabel} 下的子目录
                        </span>
                    </span>
                    <div className="dir-picker">
                        <div className="dir-breadcrumb" aria-label="路径面包屑">
                            {crumbs.map((c, i) => (
                                <span key={`${c.rel}-${i}`} className="dir-crumb-wrap">
                                    {i > 0 && <span className="dir-crumb-sep">/</span>}
                                    <button
                                        type="button"
                                        className="dir-crumb"
                                        onClick={() => browseTo(c.rel)}
                                        disabled={i === crumbs.length - 1}
                                    >
                                        {c.label}
                                    </button>
                                </span>
                            ))}
                        </div>

                        <div className="dir-list" role="listbox" aria-label="子目录">
                            {loading && <div className="dir-loading">载入中…</div>}
                            {!loading && picker && picker.dirs.length === 0 && (
                                <div className="dir-empty">此目录下没有子目录</div>
                            )}
                            {!loading &&
                                picker &&
                                picker.dirs.map((d) => (
                                    <button
                                        key={d}
                                        type="button"
                                        className="dir-item"
                                        onClick={() =>
                                            browseTo(picker.relPath ? `${picker.relPath}/${d}` : d)
                                        }
                                    >
                                        <span className="dir-item-icon" aria-hidden="true">
                                            ▸
                                        </span>
                                        <span className="dir-item-name">{d}</span>
                                    </button>
                                ))}
                        </div>

                        <div className="dir-selected">
                            <span className="dir-selected-label">将使用：</span>
                            <code className="dir-selected-path">
                                {picker?.relPath ? `./${picker.relPath}` : '.'}
                            </code>
                        </div>
                    </div>
                </div>

                {error && <p className="connect-error">{error}</p>}

                <div className="modal-actions">
                    <button type="button" className="btn btn-secondary" onClick={onClose}>
                        取消
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        disabled={creating || loading || !picker}
                        onClick={handleCreate}
                    >
                        {creating ? '创建中…' : '创建会话'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

/**
 * Turn a POSIX relPath into breadcrumb segments. An empty relPath yields
 * a single root crumb. The last crumb represents the currently-browsed
 * directory and is rendered non-interactive by the component.
 */
function buildCrumbs(rel: string): Crumb[] {
    const crumbs: Crumb[] = [{ label: '根目录', rel: '' }];
    if (!rel) return crumbs;
    const parts = rel.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        crumbs.push({ label: p, rel: acc });
    }
    return crumbs;
}
