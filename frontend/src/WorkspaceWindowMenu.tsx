import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { PANEL_IDS, PANEL_TITLES } from './workspaceLayout';
import type { PanelId, WorkspaceLayout } from './workspaceLayout';

export function WorkspaceWindowMenu({ layout, onRestore, onHide, onReset }: {
  layout: WorkspaceLayout; onRestore: (id: PanelId) => void; onHide: (id: PanelId) => void; onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const focusItem = (index: number) => {
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]');
    if (items?.length) items[(index + items.length) % items.length].focus();
  };
  return <div className="workspace-window-menu" ref={root} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Tab') { event.stopPropagation(); setOpen(false); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const items = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      focusItem(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
    }
  }}>
    <button ref={trigger} className="button secondary" type="button" aria-label="窗口" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); setOpen(true); requestAnimationFrame(() => focusItem(event.key === 'ArrowUp' ? -1 : 0));
      }
    }}>窗口<ChevronDown size={13} /></button>
    {open ? <div className="workspace-window-dropdown" role="menu" aria-label="窗口面板">
      {PANEL_IDS.map(id => <button key={id} type="button" role="menuitemcheckbox" aria-checked={layout[id].visibility === 'visible'} onClick={() => {
        if (layout[id].visibility === 'visible') onHide(id); else onRestore(id);
        setOpen(false); trigger.current?.focus();
      }}><span className="menu-check">{layout[id].visibility === 'visible' ? <Check size={14} /> : null}</span>{PANEL_TITLES[id]}<small>{layout[id].visibility === 'closed' ? '已关闭' : layout[id].visibility === 'hidden' ? '已隐藏' : layout[id].minimized ? '已最小化' : layout[id].mode === 'floating' ? '浮动' : '停靠'}</small></button>)}
      <hr /><button type="button" role="menuitem" onClick={() => { onReset(); setOpen(false); trigger.current?.focus(); }}>恢复默认工作区</button>
    </div> : null}
  </div>;
}
