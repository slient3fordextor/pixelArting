import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveRestore, FolderDown, PackageOpen, X } from 'lucide-react';
import type { Asset, Project } from './types';

type ExchangeControlsProps = {
  projectId: string;
  busy: boolean;
  beforeImport: () => Promise<boolean>;
  onImported: (asset: Asset) => void | Promise<void>;
  onProjectImported: (project: Project) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  menu?: boolean;
};

async function responseError(response: Response) {
  const result = await response.json().catch(() => null);
  const detail = result?.detail;
  return new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((item: { msg: string }) => item.msg).join('；') : `请求失败 (${response.status})`);
}

export function ExchangeControls({ projectId, busy, beforeImport, onImported, onProjectImported, onBusyChange, menu = false }: ExchangeControlsProps) {
  const bundleInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const disabled = busy || working;

  async function importArchive(file: File, kind: 'asset' | 'project') {
    if (disabled) return;
    setWorking(true); setNotice(null); onBusyChange?.(true);
    try {
      if (file.size > 128 * 1024 * 1024) throw new Error('ZIP 文件不能超过 128 MB');
      if (!await beforeImport()) return;
      onBusyChange?.(true);
      const form = new FormData(); form.append('file', file);
      const url = kind === 'asset' ? `/api/projects/${projectId}/assets/import-bundle` : '/api/projects/import-backup';
      const response = await fetch(url, { method: 'POST', body: form });
      if (!response.ok) throw await responseError(response);
      if (kind === 'asset') await onImported(await response.json() as Asset);
      else await onProjectImported(await response.json() as Project);
      setNotice({ message: kind === 'asset' ? '分层素材已导入' : '当前已保存版本已恢复为新项目', error: false });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : '导入失败', error: true });
    } finally { setWorking(false); onBusyChange?.(false); }
  }

  async function backupProject() {
    if (disabled || !projectId) return;
    setWorking(true); setNotice(null); onBusyChange?.(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/backup`);
      if (!response.ok) throw await responseError(response);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'pixelart-project.zip'; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ message: '项目当前已保存版本已备份', error: false });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : '备份失败', error: true });
    } finally { setWorking(false); onBusyChange?.(false); }
  }

  return <div className="exchange-controls">
    <div className="inline-tools">
      <button className={menu ? 'app-menu-command' : 'icon-button'} role={menu ? 'menuitem' : undefined} type="button" title="导入分层 ZIP 包" aria-label="导入分层 ZIP 包" disabled={disabled || !projectId} onClick={() => bundleInput.current?.click()}><PackageOpen size={17} />{menu ? '导入分层 ZIP 包' : null}</button>
      <button className={menu ? 'app-menu-command' : 'icon-button'} role={menu ? 'menuitem' : undefined} type="button" title="备份项目当前已保存版本" aria-label="备份项目" disabled={disabled || !projectId} onClick={() => void backupProject()}><FolderDown size={17} />{menu ? '备份项目' : null}</button>
      <button className={menu ? 'app-menu-command' : 'icon-button'} role={menu ? 'menuitem' : undefined} type="button" title="恢复项目备份" aria-label="恢复项目备份" disabled={disabled} onClick={() => projectInput.current?.click()}><ArchiveRestore size={17} />{menu ? '恢复项目备份' : null}</button>
    </div>
    <input ref={bundleInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" aria-label="分层素材 ZIP 文件" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importArchive(file, 'asset'); }} />
    <input ref={projectInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" aria-label="项目备份 ZIP 文件" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importArchive(file, 'project'); }} />
    {notice ? menu ? createPortal(<div role={notice.error ? 'alert' : 'status'} className={`toast exchange-notice ${notice.error ? 'error' : ''}`}><span>{notice.message}</span><button className="icon-button" type="button" aria-label="关闭备份导入提示" onClick={() => setNotice(null)}><X size={16} /></button></div>, document.body) : <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'exchange-notice error' : 'exchange-notice'}>{notice.message}</p> : null}
  </div>;
}
