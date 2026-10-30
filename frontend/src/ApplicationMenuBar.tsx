import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function ApplicationMenuBar({ children }: { children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      root.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(menu => { menu.open = false; });
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return <nav ref={root} className="app-menu-bar" aria-label="应用菜单" onClick={event => {
    if (!(event.target instanceof Element)) return;
    const menu = event.target.closest('details');
    if (!menu || !root.current?.contains(menu)) {
      root.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(other => { other.open = false; });
      return;
    }
    root.current.querySelectorAll<HTMLDetailsElement>('details').forEach(other => { if (other !== menu) other.open = false; });
    if (event.target.closest('button:not(:disabled)')) {
      (menu as HTMLDetailsElement).open = false;
    }
  }} onKeyDown={event => {
    event.stopPropagation();
    if (!(event.target instanceof Element)) return;
    const menu = event.target.closest('details');
    if (!menu || !root.current?.contains(menu)) return;
    const trigger = menu.querySelector('summary');
    if (event.key === 'Escape') {
      event.preventDefault(); menu.open = false; trigger?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); menu.open = true;
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index < 0 ? (event.key === 'ArrowUp' ? items.length - 1 : 0) : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const menus = Array.from(root.current.querySelectorAll<HTMLDetailsElement>('details'));
      const next = menus[(menus.indexOf(menu) + (event.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length];
      menu.open = false; next.open = true; next.querySelector('summary')?.focus();
    } else if (event.key === 'Tab') {
      menu.open = false;
    }
  }}>{children}</nav>;
}
