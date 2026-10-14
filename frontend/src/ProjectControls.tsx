import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Save, Settings2, Trash2, X } from 'lucide-react';
import type { AssetItem, Project } from './types';
import './ProjectControls.css';

type ProjectControlsProps = {
  project: Project | null;
  busy: boolean;
  beforeDelete: () => Promise<boolean>;
  onUpdated: (project: Project) => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
};

async function checkedResponse(response: Response) {
  if (response.ok) return response;
  const result = await response.json().catch(() => null);
  const detail = result?.detail;
  throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((item: { msg: string }) => item.msg).join('；') : `请求失败 (${response.status})`);
}

export function ProjectControls({ project, busy, beforeDelete, onUpdated, onDeleted, onBusyChange }: ProjectControlsProps) {
  const [editing, setEditing] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = busy || working;

  useEffect(() => {
    if (!editing) return;
    const previous = document.activeElement;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
    return () => { if (previous instanceof HTMLElement && document.contains(previous)) previous.focus({ preventScroll: true }); };
  }, [editing?.id]);

  useEffect(() => {
    if (editing && editing.id !== project?.id && !working) setEditing(null);
  }, [project?.id, editing?.id, working]);

  function open() {
    if (!project || disabled) return;
    setEditing({ ...project }); setName(project.name); setConfirmation(''); setError(null);
  }

  async function rename() {
    const trimmed = name.trim();
    if (!editing || disabled || !trimmed || trimmed.length > 80 || trimmed === editing.name) return;
    setWorking(true); setError(null); onBusyChange?.(true);
    try {
      const response = await checkedResponse(await fetch(`/api/projects/${editing.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmed, expectedName: editing.name }),
      }));
      await onUpdated(await response.json() as Project);
      setEditing(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '项目改名失败'); }
    finally { setWorking(false); onBusyChange?.(false); }
  }

  async function remove() {
    if (!editing || disabled || confirmation !== editing.name) return;
    setWorking(true); setError(null); onBusyChange?.(true);
    try {
      if (!await beforeDelete()) return;
      onBusyChange?.(true);
      const assetsResponse = await checkedResponse(await fetch(`/api/projects/${editing.id}/assets`));
      const assets = await assetsResponse.json() as AssetItem[];
      await checkedResponse(await fetch(`/api/projects/${editing.id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedName: editing.name, expectedCurrentVersions: Object.fromEntries(assets.map(asset => [asset.id, asset.currentVersionId])) }),
      }));
      await onDeleted();
      setEditing(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '项目删除失败'); }
    finally { setWorking(false); onBusyChange?.(false); }
  }

  return <>
    <button className="icon-button" type="button" title="管理项目" aria-label="管理项目" disabled={!project || disabled} onClick={open}><Settings2 size={17} /></button>
    {editing ? createPortal(<div className="project-management-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !disabled) setEditing(null); }}>
      <section ref={dialogRef} className="project-management-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={working} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !disabled) { event.preventDefault(); setEditing(null); }
        if (event.key !== 'Tab') return;
        const controls = Array.from(dialogRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
        if (!controls.length) { event.preventDefault(); return; }
        const first = controls[0], last = controls.at(-1)!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
        <div className="project-management-heading"><h2 id={titleId}>项目设置</h2><button className="icon-button" type="button" title="关闭项目设置" aria-label="关闭项目设置" disabled={disabled} onClick={() => setEditing(null)}><X size={17} /></button></div>
        <form onSubmit={event => { event.preventDefault(); void rename(); }}>
          <label className="project-management-field">项目名称<input ref={inputRef} aria-label="修改项目名称" value={name} maxLength={80} required disabled={disabled} onChange={event => setName(event.target.value)} /></label>
          <div className="project-management-actions"><button className="button secondary" type="submit" disabled={disabled || !name.trim() || name.trim() === editing.name}><Save size={15} />保存项目名称</button></div>
        </form>
        <form className="project-management-danger-zone" onSubmit={event => { event.preventDefault(); void remove(); }}>
          <h3>删除项目</h3>
          <p>项目中的素材及全部历史版本将永久删除，无法撤销。</p>
          <p>输入完整项目名 <strong className="project-management-name">“{editing.name}”</strong> 确认删除。</p>
          <label className="project-management-field">项目名确认<input aria-label="输入项目名确认删除" value={confirmation} required disabled={disabled} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label>
          <div className="project-management-actions"><button className="button project-management-delete" type="submit" disabled={disabled || confirmation !== editing.name}><Trash2 size={15} />永久删除项目</button></div>
        </form>
        {error ? <p role="alert" className="project-management-error">{error}</p> : null}
      </section>
    </div>, document.body) : null}
  </>;
}
