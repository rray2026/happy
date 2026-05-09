import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useEscape, useScrollLock } from '../hooks/overlay';

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

    useScrollLock(open);
    useEscape(open, onClose);

    useEffect(() => {
        if (!open) return;

        prevFocusRef.current = document.activeElement as HTMLElement | null;

        // Move focus into the modal (first focusable, else the card itself).
        const raf = requestAnimationFrame(() => {
            const card = cardRef.current;
            if (!card) return;
            const focusable = card.querySelector<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            );
            (focusable ?? card).focus();
        });

        return () => {
            cancelAnimationFrame(raf);
            // Restore focus to whatever opened us.
            prevFocusRef.current?.focus?.();
        };
    }, [open]);

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
