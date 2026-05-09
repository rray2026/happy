import { useToasts, dismissToast } from '../toast/toastStore';

export function ToastViewport() {
    const toasts = useToasts();
    if (toasts.length === 0) return null;
    return (
        <div className="toast-viewport" role="region" aria-label="通知">
            {toasts.map((t) => (
                <div key={t.id} className={`toast toast-${t.kind}`} role="status">
                    <span className="toast-message">{t.message}</span>
                    {t.action && (
                        <button
                            type="button"
                            className="toast-action"
                            onClick={() => {
                                t.action!.onClick();
                                dismissToast(t.id);
                            }}
                        >
                            {t.action.label}
                        </button>
                    )}
                    <button
                        type="button"
                        className="toast-close"
                        onClick={() => dismissToast(t.id)}
                        aria-label="关闭"
                    >
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}
