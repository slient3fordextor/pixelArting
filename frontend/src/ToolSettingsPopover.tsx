import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, X } from 'lucide-react';

type Props = {
  title: string;
  open: boolean;
  anchorRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: ReactNode;
};

export function ToolSettingsPopover({ title, open, anchorRef, onClose, children }: Props) {
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const popup = useRef<HTMLDivElement>(null);
  const trigger = () => anchorRef.current?.querySelector<HTMLButtonElement>('button.active');

  useLayoutEffect(() => {
    if (!open || !trigger() || !popup.current) return;
    const anchor = trigger()!.getBoundingClientRect();
    const bounds = popup.current.getBoundingClientRect();
    const below = anchor.bottom + 8;
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(below + bounds.height <= window.innerHeight - 8 ? below : anchor.top - bounds.height - 8, window.innerHeight - bounds.height - 8)),
    });
    (popup.current.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), .tool-settings-panel button:not(:disabled)') ?? popup.current).focus({ preventScroll: true });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      // A replacement popover can receive focus before this one's effect cleans up.
      if (event.target instanceof Element && event.target.closest('.tool-settings-popover')) return;
      if (!popup.current?.contains(event.target as Node) && !anchorRef.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      trigger()?.focus({ preventScroll: true });
    };
    const dismiss = () => onClose();
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open, anchorRef, onClose]);

  return open ? createPortal(<div ref={popup} className="tool-settings-popover" role="dialog" tabIndex={-1}
    aria-label={title} style={position} onKeyDown={event => event.stopPropagation()}>
    <div className="tool-settings-heading"><strong><Settings2 size={15} />{title}</strong>
      <button className="icon-button" type="button" aria-label={`关闭${title}`} onClick={() => {
        onClose(); trigger()?.focus({ preventScroll: true });
      }}><X size={15} /></button>
    </div>
    {children}
  </div>, document.body) : null;
}
