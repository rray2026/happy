import { useEffect, useId, useRef, type ReactNode } from 'react';

interface ModalProps {
    open: boolean;
    title: string;
    onClose: () => void;
    children: ReactNode;
    /** Optional width modifier — controls `.modal-card` max-width. */
    size?: 'sm' | 'md' | 'lg';
    /** Render without the default chrome (title + close button). Used for
     *  full-bleed surfaces like the logs viewer that style their own header. */
    bare?: boolean;
    /** Accessible label when `bare` is true and no visible title is rendered. */
    ariaLabel?: string;
}

/**
 * Accessible modal primitive:
 * - role="dialog" + aria-modal, labelled by the title
 * - Escape closes
 * - Click backdrop closes
 * - Focus is trapped softly (initial focus in; restores to trigger on close)
 * - Body scroll locked while open
 */
export function Modal({
    open,
    title,
    onClose,
    children,
    size = 'md',
    bare = false,
    ariaLabel,
}: ModalProps) {
    const titleId = useId();
    const cardRef = useRef<HTMLDivElement>(null);
    const prevFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!open) return;

        prevFocusRef.current = document.activeElement as HTMLElement | null;

        // Lock body scroll.
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        // Move focus into the modal (first focusable, else the card itself).
        const raf = requestAnimationFrame(() => {
            const card = cardRef.current;
            if (!card) return;
            const focusable = card.querySelector<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            );
            (focusable ?? card).focus();
        });

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
            // Restore focus to whatever opened us.
            prevFocusRef.current?.focus?.();
        };
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div
            className="modal-overlay"
            onClick={onClose}
            role="presentation"
        >
            <div
                ref={cardRef}
                className={`modal-card modal-card-${size}${bare ? ' modal-card-bare' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby={bare ? undefined : titleId}
                aria-label={bare ? (ariaLabel ?? title) : undefined}
                tabIndex={-1}
                onClick={e => e.stopPropagation()}
            >
                {!bare && (
                    <div className="modal-head">
                        <h3 id={titleId} className="modal-title">{title}</h3>
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={onClose}
                            aria-label="关闭"
                        >
                            ✕
                        </button>
                    </div>
                )}
                {children}
            </div>
        </div>
    );
}
