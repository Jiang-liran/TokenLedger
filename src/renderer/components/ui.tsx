import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { useAppStore } from '../store';

export function Popover({
  open,
  onClose,
  children,
  align = 'left',
  width,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={`popover ${className}`}
      style={{
        top: 'calc(100% + 6px)',
        ...(align === 'right' ? { right: 0 } : { left: 0 }),
        ...(width ? { width, maxWidth: 'calc(100vw - 32px)' } : {}),
      }}
      role="dialog"
    >
      {children}
    </div>
  );
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  actions,
  width,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="modal-title">{title}</h2>
            {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`}>
          <div
            className="status-dot mt-1.5 flex-none"
            style={{
              background:
                toast.tone === 'error'
                  ? 'var(--danger)'
                  : toast.tone === 'success'
                    ? 'var(--success)'
                    : 'var(--accent)',
            }}
          />
          <div className="flex-1 whitespace-pre-wrap break-words">{toast.message}</div>
          <button className="icon-btn -mr-1 -mt-1 h-5 w-5" onClick={() => dismiss(toast.id)} aria-label="关闭提示">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const confirm = useAppStore((state) => state.confirm);
  const resolve = useAppStore((state) => state.resolveConfirm);
  return (
    <Modal
      open={!!confirm}
      title={confirm?.title ?? ''}
      onClose={() => resolve(false)}
      actions={
        <>
          <button className="btn" onClick={() => resolve(false)}>
            取消
          </button>
          <button
            className={confirm?.danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => resolve(true)}
          >
            {confirm?.confirmLabel ?? '确认'}
          </button>
        </>
      }
    >
      <p className="modal-sub" style={{ marginBottom: 0 }}>
        {confirm?.message}
      </p>
      {confirm?.detail ? (
        <p className="hint" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          {confirm.detail}
        </p>
      ) : null}
    </Modal>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  );
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button type="button" onClick={copy} className="inline-flex items-center gap-1">
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? '已复制' : label}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-1 text-[var(--text-tertiary)]">
      <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-current" style={{ animationDelay: '150ms' }} />
      <span className="h-1 w-1 animate-pulse rounded-full bg-current" style={{ animationDelay: '300ms' }} />
    </span>
  );
}
