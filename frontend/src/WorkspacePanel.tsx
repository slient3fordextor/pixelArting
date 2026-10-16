import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, MouseEventHandler } from 'react';
import { ChevronsLeft, ChevronsRight, Dock, Folder, Layers, Minus, MoreHorizontal, Palette, PanelsTopLeft, SlidersHorizontal, X } from 'lucide-react';
import { PANEL_TITLES } from './workspaceLayout';
import type { PanelId, PanelState } from './workspaceLayout';

const icons = { library: Folder, inspector: Layers, tools: SlidersHorizontal, palette: Palette, timeline: PanelsTopLeft };

type Props = {
  id: PanelId;
  state: PanelState;
  className?: string;
  children: ReactNode;
  actions?: ReactNode;
  active: boolean;
  onActivate: (id: PanelId) => void;
  onChange: (id: PanelId, patch: Partial<PanelState>) => void;
  onContextMenu?: MouseEventHandler;
};

export function WorkspacePanel({ id, state, className = '', children, actions, active, onActivate, onChange, onContextMenu }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const dragged = useRef(false);
  const drag = useRef<{ pointer: number; dx: number; dy: number; x: number; y: number; startX: number; startY: number; detached: boolean } | null>(null);
  const title = PANEL_TITLES[id];
  const Icon = icons[id];
  const floating = state.mode === 'floating';
  const sidebar = id === 'library' || id === 'inspector';

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuButton.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuOpen]);

  useEffect(() => { setMenuOpen(false); }, [state.mode, state.visibility]);

  useEffect(() => {
    if (!floating || state.visibility !== 'visible') return;
    const keepOnscreen = () => {
      const element = panelRef.current;
      if (!element || drag.current) return;
      const bounds = element.getBoundingClientRect();
      const x = Math.max(8, Math.min(state.x, window.innerWidth - bounds.width - 8));
      const y = Math.max(64, Math.min(state.y, window.innerHeight - bounds.height - 8));
      if (x !== state.x || y !== state.y) onChange(id, { x, y });
    };
    keepOnscreen();
    window.addEventListener('resize', keepOnscreen);
    const observer = new ResizeObserver(keepOnscreen);
    if (panelRef.current) observer.observe(panelRef.current);
    return () => { window.removeEventListener('resize', keepOnscreen); observer.disconnect(); };
  }, [floating, state.visibility, state.x, state.y, id, onChange]);

  const finishDrag = () => {
    const moving = drag.current;
    drag.current = null;
    if (!moving || !dragged.current || !panelRef.current) return;
    const bounds = panelRef.current.getBoundingClientRect();
    onChange(id, {
      x: Math.max(8, Math.min(window.innerWidth - bounds.width - 8, moving.x)),
      y: Math.max(64, Math.min(window.innerHeight - bounds.height - 8, moving.y)),
    });
  };

  const minimizeLabel = id === 'timeline' ? (state.minimized ? '展开时间轴' : '折叠时间轴') : `${state.minimized ? '展开' : '最小化'}${title}`;
  return <section ref={panelRef} data-panel={id} data-mode={state.mode} data-visibility={state.visibility}
    aria-label={`${title}面板`} hidden={state.visibility !== 'visible'} onContextMenu={onContextMenu}
    className={`workspace-panel ${className} ${floating ? 'panel-floating' : 'panel-docked'} ${state.minimized ? 'panel-minimized' : ''} ${sidebar ? 'panel-sidebar' : ''}`}
    style={floating ? { left: state.x, top: state.y, zIndex: active ? 14 : 9 } as CSSProperties : undefined}
    onPointerDownCapture={() => { if (floating) onActivate(id); }}
    onKeyDown={event => { if (event.key === 'Tab') event.stopPropagation(); }}>
    <div className="workspace-panel-heading">
      <button type="button" className="panel-title" aria-label={state.minimized ? `恢复${title}面板` : `移动${title}`}
        title={state.minimized ? `展开${title}` : `${title} · 拖动移动，双击${floating ? '停靠' : '浮动'}`}
        onDoubleClick={() => onChange(id, { mode: floating ? 'docked' : 'floating' })}
        onClick={event => { if (state.minimized && (event.detail === 0 || !dragged.current)) onChange(id, { minimized: false }); }}
        onKeyDown={event => {
          if (!floating || !event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const bounds = panelRef.current!.getBoundingClientRect();
          onChange(id, {
            x: Math.max(8, Math.min(window.innerWidth - bounds.width - 8, state.x + (event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0))),
            y: Math.max(64, Math.min(window.innerHeight - bounds.height - 8, state.y + (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0))),
          });
        }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          const bounds = panelRef.current!.getBoundingClientRect();
          dragged.current = false;
          drag.current = { pointer: event.pointerId, dx: floating ? event.clientX - bounds.left : Math.min(event.clientX - bounds.left, 160), dy: event.clientY - bounds.top, x: bounds.left, y: bounds.top, startX: event.clientX, startY: event.clientY, detached: floating };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const moving = drag.current;
          if (!moving || moving.pointer !== event.pointerId) return;
          if (!dragged.current && Math.hypot(event.clientX - moving.startX, event.clientY - moving.startY) < 5) return;
          dragged.current = true;
          if (!moving.detached) {
            moving.detached = true;
            moving.x = Math.max(8, event.clientX - moving.dx);
            moving.y = Math.max(64, event.clientY - moving.dy);
            onActivate(id);
            onChange(id, { mode: 'floating', x: moving.x, y: moving.y });
            return;
          }
          const element = panelRef.current!;
          const bounds = element.getBoundingClientRect();
          moving.x = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, event.clientX - moving.dx));
          moving.y = Math.max(64, Math.min(window.innerHeight - bounds.height - 8, event.clientY - moving.dy));
          element.style.left = `${moving.x}px`; element.style.top = `${moving.y}px`;
        }}
        onPointerUp={event => {
          if (drag.current?.pointer !== event.pointerId) return;
          finishDrag();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={finishDrag}>{floating || id === 'tools' ? <Icon size={15} /> : null}{id !== 'tools' ? <span>{title}</span> : null}</button>
      <div className="panel-window-actions">
        {actions}
        <button type="button" className="icon-button" title={minimizeLabel} aria-label={minimizeLabel} aria-expanded={!state.minimized} onClick={() => onChange(id, { minimized: !state.minimized })}>{state.minimized ? <ChevronsRight size={14} /> : sidebar ? <ChevronsLeft size={14} /> : <Minus size={14} />}</button>
        {floating ? <>
          <button type="button" className="icon-button" title={`停靠${title}`} aria-label={`停靠${title}`} onClick={() => onChange(id, { mode: 'docked' })}><Dock size={14} /></button>
          <button type="button" className="icon-button" title={`关闭${title}`} aria-label={`关闭${title}`} onClick={() => onChange(id, { visibility: 'closed' })}><X size={14} /></button>
        </> : null}
        <button ref={menuButton} type="button" className="icon-button" title={`${title}菜单`} aria-label={`${title}菜单`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><MoreHorizontal size={id === 'tools' ? 17 : 14} /></button>
      </div>
    </div>
    {menuOpen ? <div ref={menuRef} className="panel-menu" role="menu" aria-label={`${title}菜单`} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Tab') {
        setMenuOpen(false);
        if (event.key === 'Escape') { event.preventDefault(); menuButton.current?.focus(); }
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(menuRef.current!.querySelectorAll<HTMLButtonElement>('button'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
      {[
        { label: `${floating ? '停靠' : '浮动'}${title}`, patch: { mode: floating ? 'docked' : 'floating' } as Partial<PanelState> },
        { label: `隐藏${title}`, patch: { visibility: 'hidden' } as Partial<PanelState> },
        { label: `关闭${title}`, patch: { visibility: 'closed' } as Partial<PanelState> },
      ].map(item => <button key={item.label} type="button" role="menuitem" onClick={() => { onChange(id, item.patch); setMenuOpen(false); menuButton.current?.focus(); }}>{item.label}</button>)}
    </div> : null}
    <div className="workspace-panel-body" hidden={state.minimized}>{children}</div>
  </section>;
}
