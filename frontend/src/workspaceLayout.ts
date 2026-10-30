import { useCallback, useEffect, useState } from 'react';

export const PANEL_TITLES = { library: '素材', inspector: '检查器', tools: '工具栏', palette: '调色板', timeline: '时间轴' } as const;
export type PanelId = keyof typeof PANEL_TITLES;
export const PANEL_IDS = Object.keys(PANEL_TITLES) as PanelId[];
export const WORKSPACE_LAYOUT_KEY = 'pixelart-workspace-layout-v1';
export type PanelState = {
  visibility: 'visible' | 'hidden' | 'closed';
  mode: 'docked' | 'floating';
  minimized: boolean;
  x: number;
  y: number;
};
export type WorkspaceLayout = Record<PanelId, PanelState>;

export function defaultWorkspaceLayout(): WorkspaceLayout {
  return Object.fromEntries(PANEL_IDS.map((id, index) => [id, {
    visibility: 'visible', mode: 'docked', minimized: false, x: 80 + index * 36, y: 100 + index * 32,
  }])) as WorkspaceLayout;
}

function readLayout(): WorkspaceLayout {
  const layout = defaultWorkspaceLayout();
  try {
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) || '{}');
    for (const id of PANEL_IDS) {
      const panel = stored?.[id];
      if (!panel || typeof panel !== 'object') continue;
      layout[id] = {
        visibility: panel.visibility === 'hidden' || panel.visibility === 'closed' ? panel.visibility : 'visible',
        mode: panel.mode === 'floating' ? 'floating' : 'docked',
        minimized: panel.minimized === true,
        x: Number.isFinite(panel.x) ? Math.max(8, Math.min(window.innerWidth - 48, panel.x)) : layout[id].x,
        y: Number.isFinite(panel.y) ? Math.max(64, Math.min(window.innerHeight - 48, panel.y)) : layout[id].y,
      };
    }
  } catch { /* An invalid layout falls back to the default workspace. */ }
  return layout;
}

export function useWorkspaceLayout(onReveal: (focused: false) => void) {
  const [layout, setLayout] = useState(readLayout);
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  useEffect(() => {
    try { localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(layout)); }
    catch { /* The current session remains usable when storage is unavailable. */ }
  }, [layout]);
  const updatePanel = useCallback((id: PanelId, patch: Partial<PanelState>) => {
    setLayout(current => ({ ...current, [id]: { ...current[id], ...patch } }));
  }, []);
  const restorePanel = useCallback((id: PanelId) => {
    setLayout(current => ({ ...current, [id]: { ...current[id], visibility: 'visible', minimized: false } }));
    setActivePanel(id);
  }, []);
  const expandToolOptions = useCallback(() => {
    setLayout(current => current.tools.visibility === 'visible' && current.tools.minimized
      ? { ...current, tools: { ...current.tools, minimized: false } } : current);
  }, []);
  const resetLayout = useCallback(() => { setLayout(defaultWorkspaceLayout()); setActivePanel(null); }, []);
  useEffect(() => {
    const command = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (name === 'workspace:reset') { onReveal(false); resetLayout(); }
      if (name?.startsWith('panel:') && PANEL_IDS.includes(name.slice(6) as PanelId)) {
        onReveal(false); restorePanel(name.slice(6) as PanelId);
      }
    };
    window.addEventListener('pixelart-command', command);
    return () => window.removeEventListener('pixelart-command', command);
  }, [resetLayout, restorePanel, onReveal]);
  return { layout, updatePanel, restorePanel, resetLayout, expandToolOptions, activePanel, setActivePanel };
}
