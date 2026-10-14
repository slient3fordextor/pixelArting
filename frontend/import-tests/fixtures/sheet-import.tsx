import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SpriteSheetImport } from '../../src/SpriteSheetImport';
import type { Asset } from '../../src/types';
import '../../src/styles.css';

function ImportFixture() {
  const params = new URLSearchParams(window.location.search);
  const [imported, setImported] = useState<Asset | null>(null);
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-label="导入素材"><div className="modal-heading"><h2>导入素材</h2></div><SpriteSheetImport projectId={params.get('projectId') || ''} beforeImport={() => params.get('allow') !== 'no'} onImport={setImported} /><output data-testid="imported-asset" hidden>{imported ? JSON.stringify(imported) : ''}</output></div></div>;
}

createRoot(document.getElementById('root')!).render(<ImportFixture />);
