import { useEffect, useMemo, useRef, useState } from 'react';
import { CopyPlus, Folder, RefreshCw, Search, X } from 'lucide-react';
import type { LibraryAsset } from './types';

type AssetLibraryDialogProps = {
  assets: LibraryAsset[];
  currentProjectId: string;
  busy: boolean;
  onClose: () => void;
  onUse: (asset: LibraryAsset) => void;
  onRemove: (asset: LibraryAsset) => void;
  onRefresh: () => void;
};

export function AssetLibraryDialog({ assets, currentProjectId, busy, onClose, onUse, onRemove, onRefresh }: AssetLibraryDialogProps) {
  const [query, setQuery] = useState('');
  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    search.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? assets.filter(item => `${item.name} ${item.projectName}`.toLocaleLowerCase().includes(needle)) : assets;
  }, [assets, query]);

  return <div className="asset-library-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={root} className="asset-library-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-library-title" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const controls = Array.from(root.current!.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'));
        const edge = event.shiftKey ? controls[0] : controls.at(-1);
        if (event.target === edge) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus(); }
      }
    }}>
      <header className="asset-library-heading">
        <div><h2 id="asset-library-title">素材库</h2><p className="asset-library-subtitle">只展示已确认收录的素材。使用后会在当前项目创建独立副本。</p></div>
        <button className="icon-button" type="button" aria-label="关闭素材库" disabled={busy} onClick={onClose}><X size={17} /></button>
      </header>
      <div className="asset-library-toolbar">
        <label className="asset-library-search"><Search size={16} /><input ref={search} aria-label="搜索素材库" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索素材名或来源项目" /></label>
        <button className="icon-button" type="button" title="刷新素材库" aria-label="刷新素材库" disabled={busy} onClick={onRefresh}><RefreshCw size={16} /></button>
      </div>
      <div className="asset-library-grid" aria-live="polite">
        {filtered.map(item => <article className="asset-library-card" key={item.id}>
          <div className="asset-library-card-main">
            <img src={`/api/library/${item.id}/thumbnail`} alt={`${item.name}预览`} loading="lazy" />
            <span className="asset-library-card-copy"><strong title={item.name}>{item.name}</strong><small><Folder size={12} />{item.projectName}</small><small>{item.width} × {item.height} · {item.frameCount} 帧 · {item.layerCount} 图层</small></span>
          </div>
          <div className="asset-library-card-actions"><button className="text-button" type="button" disabled={busy} onClick={() => onRemove(item)}>移出素材库</button><button className="button secondary" type="button" aria-label={`使用素材 ${item.name}`} disabled={busy || !currentProjectId} onClick={() => onUse(item)}><CopyPlus size={14} />用于当前项目</button></div>
        </article>)}
      </div>
      {!filtered.length ? <div className="asset-library-empty"><Search size={25} /><strong>{query ? '没有匹配的素材' : '还没有收录素材'}</strong><span>{query ? '换个关键词试试。' : '在左侧项目素材中点击“加入素材库”，确认后即可在这里复用。'}</span></div> : null}
      <footer className="asset-library-footer"><span>{filtered.length} / {assets.length} 个素材</span><span>收录时保存版本快照，项目编辑不会改动素材库</span></footer>
    </section>
  </div>;
}
