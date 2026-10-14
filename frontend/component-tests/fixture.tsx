import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../src/api';
import { RepairControls } from '../src/RepairControls';
import { VersionHistory } from '../src/VersionHistory';
import { CanvasEditor } from '../src/CanvasEditor';
import { defaultConfig } from '../src/types';
import type { Asset, Document, Preview } from '../src/types';
import '../src/styles.css';

function Fixture() {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [draft, setDraft] = useState<Document | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dirty, setDirty] = useState(false);
  const [allowRestore, setAllowRestore] = useState(true);
  const [saveBeforeRestore, setSaveBeforeRestore] = useState(false);
  const [error, setError] = useState('');
  const colorRef = useRef('#218F83');
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('asset');
    if (!id) return;
    api<Asset>(`/assets/${id}`).then(next => { setAsset(next); setDraft(structuredClone(next.document)); }).catch(failure => setError(failure.message));
  }, []);
  return <main style={{ maxWidth: 1000, margin: '0 auto', padding: 16 }}>
    {error ? <p role="alert">{error}</p> : null}
    <output aria-label="当前版本">{asset?.currentVersionId}</output>
    <label className="checkbox-row"><input type="checkbox" aria-label="允许恢复" checked={allowRestore} onChange={event => setAllowRestore(event.target.checked)} />允许恢复</label>
    <label className="checkbox-row"><input type="checkbox" aria-label="草稿未保存" checked={dirty} onChange={event => setDirty(event.target.checked)} />草稿未保存</label>
    <label className="checkbox-row"><input type="checkbox" aria-label="先保存再恢复" checked={saveBeforeRestore} onChange={event => setSaveBeforeRestore(event.target.checked)} />先保存再恢复</label>
    <VersionHistory asset={asset} draft={draft} selectedLayer="base" frameIndex={0} zoom={4} colorRef={colorRef} onRestore={next => { setAsset(next); setDraft(structuredClone(next.document)); }} beforeRestore={async () => {
      if (!allowRestore) return false;
      if (saveBeforeRestore && asset && draft) {
        const next = await api<Asset>(`/assets/${asset.id}/save`, { expectedCurrentVersionId: asset.currentVersionId, document: { ...draft, name: `${draft.name} 已保存` } });
        setAsset(next);
        setDraft(structuredClone(next.document));
      }
      return true;
    }} />
    <RepairControls asset={asset} config={{ ...defaultConfig, targetWidth: 8, targetHeight: 8 }} dirty={dirty} onPreview={setPreview} />
    {preview ? <><output aria-label="修复预览参数">{JSON.stringify(preview.actions)}</output><output aria-label="修复基础版本">{preview.baseVersionId}</output><CanvasEditor frame={preview.document.frames[0]} layers={preview.document.layers} activeLayer="base" colorRef={colorRef} tool="pencil" zoom={4} grid={false} readonly label="组件修复结果画布" /></> : null}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
