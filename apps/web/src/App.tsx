import { useEffect, useState } from 'react';

const api = (p: string, o?: any) => fetch(p, o).then(r => r.json());

export default function App() {
  const [page, setPage] = useState<'home' | 'rules' | 'reports' | 'session'>('home');
  const [inspections, setInspections] = useState<any[]>([]);
  const [cadModels, setCadModels] = useState<any[]>([]);
  const [rules, setRules] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [modelId, setModelId] = useState('CVS6000_VALVE');
  const [current, setCurrent] = useState<any>(null);
  const [evidence, setEvidence] = useState<any[]>([]);
  const [sessionRules, setSessionRules] = useState<any>(null);
  const [documents, setDocuments] = useState<any>(null);
  const [tab, setTab] = useState('Live');

  const loadHome = () => api('/api/v1/inspections').then(j => setInspections(j.inspections || []));
  useEffect(() => { loadHome(); api('/api/v1/cad-models').then(j => setCadModels(j.cad_models || [])); api('/api/v1/instruction-sets').then(setRules); api('/api/v1/reports').then(j => setReports(j.reports || [])); }, []);
  useEffect(() => { if (page === 'session' && current) { const t = setInterval(async () => { const i = await api(`/api/v1/inspections/${current.id}`); setCurrent(i); setEvidence(await api(`/api/v1/inspections/${current.id}/evidence`)); setSessionRules(await api(`/api/v1/inspections/${current.id}/rules`)); setDocuments(await api(`/api/v1/inspections/${current.id}/documents`)); }, 1500); return () => clearInterval(t); } }, [page, current?.id]);

  const create = async () => { const i = await api('/api/v1/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, model_id: modelId }) }); setCurrent(i); setPage('session'); setTab('Live'); loadHome(); };
  const close = async (term: boolean) => { if (!confirm(term ? 'Terminate now?' : 'End inspection?')) return; const i = await api(`/api/v1/inspections/${current.id}/${term ? 'terminate' : 'close'}`, { method: 'POST' }); setCurrent(i); api('/api/v1/reports').then(j => setReports(j.reports || [])); loadHome(); };

  const photos = evidence.filter(e => e.mediaType === 'photo'), videos = evidence.filter(e => e.mediaType === 'video'), pcs = evidence.filter(e => e.mediaType === 'pointcloud');
  const closed = current && ['COMPLETED', 'TERMINATED'].includes(current.lifecycleStatus);

  return (
    <div className="ar-app">
      <header className="ar-top">
        <div className="ar-logo"><svg viewBox="0 0 26 26" fill="none"><circle cx="13" cy="13" r="11.5" stroke="#A594FF" strokeWidth="1.5" /><path d="M10 8.5v9l8-4.5Z" fill="#A594FF" /></svg>Argus</div>
        <nav className="ar-nav">
          <button className="ar-navlink" aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}>Home</button>
          <button className="ar-navlink" aria-current={page === 'rules' ? 'page' : undefined} onClick={() => setPage('rules')}>Inspection Rules</button>
          <button className="ar-navlink" aria-current={page === 'reports' ? 'page' : undefined} onClick={() => setPage('reports')}>Reports</button>
        </nav>
        <div className="ar-spacer" /><span className="ar-badge plain">Autonomous Industrial Inspection</span>
      </header>
      <div className="ar-scroll"><main className="ar-page">
        {page === 'home' && <>
          <h1 className="ar-h1">Autonomous Industrial Inspection</h1>
          <p className="ar-lead">Live video, photographs and laser scans, checked against approved CAD and inspection rules.</p>
          <div className="ar-split">
            <section className="ar-card pad ar-grow"><h2 className="ar-h2">Inspections</h2>
              {inspections.map(i => <button key={i.id} className="ar-row" onClick={() => { setCurrent(i); setPage('session'); }}><span>{i.name}<br /><span className="ar-mono ar-micro">{i.id}</span></span><span className="ar-badge">{i.lifecycleStatus}</span><span className="ar-badge plain">{i.outcome}</span></button>)}
              {!inspections.length && <p className="ar-muted">No inspections yet.</p>}
            </section>
            <section className="ar-card pad ar-side" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 className="ar-h2">Start inspection</h2>
              <div className="ar-field"><label>Inspection name</label><input className="ar-input" value={name} onChange={e => setName(e.target.value)} placeholder="CVS 6000D — Blue Valve Run" /></div>
              <div className="ar-field"><label>CAD model</label><select className="ar-select" value={modelId} onChange={e => setModelId(e.target.value)}>{cadModels.map(m => <option key={m.model_id} value={m.model_id}>{m.display_name}</option>)}</select></div>
              <div className="ar-field"><label>Customer specification or work order (optional)</label><input className="ar-input" type="file" accept=".pdf,.docx,.xlsx" /></div>
              <p className="ar-small">Rules derived from selected CAD model plus the effective customer document. No upload uses the pinned demo work order.</p>
              <button className="ar-btn primary" disabled={!name.trim()} onClick={create}>Start Inspection</button>
            </section>
          </div></>}
        {page === 'rules' && <><h1 className="ar-h1">Inspection Rules</h1><p className="ar-lead">{rules?.rules?.length ?? 0} indexed rules · pack {rules?.packId}</p>
          {(rules?.rules || []).map((r: any) => <div key={r.ruleId} className="ar-card pad"><b>{r.ruleId} · {r.title}</b><p className="ar-small">{r.category} · {r.applicability} · modalities: {(r.modalities || []).join(', ') || 'none'}</p><p>“{r.quote}” — {r.source}, p.{r.page}, §{r.section}</p></div>)}</>}
        {page === 'reports' && <><h1 className="ar-h1">Reports</h1>
          {reports.map((r: any) => <div key={r.sessionId} className="ar-card pad"><b>{r.sessionId}</b> · {r.partial ? 'Partial' : 'Full'} · {r.outcome} · <a href={`/api/v1/inspections/${r.sessionId}/dossier`} target="_blank">View dossier API</a></div>)}
          {!reports.length && <p className="ar-muted">No dossiers yet.</p>}</>}
        {page === 'session' && current && <>
          <p><button className="ar-link" onClick={() => setPage('home')}>‹ Inspections</button></p>
          <div className="ar-bar" style={{ justifyContent: 'space-between' }}><h1 className="ar-h2" style={{ fontSize: 22 }}>{current.name}</h1><span className="ar-badge">{current.lifecycleStatus}</span><span className="ar-badge plain">{current.outcome}</span></div>
          <p className="ar-mono">{current.id} · CAD {current.model_id} · Copy this ID into the Simulator</p>
          {!closed && <div className="ar-bar"><button className="ar-btn secondary" onClick={() => close(false)}>End Inspection</button><button className="ar-btn danger" onClick={() => close(true)}>Terminate Now</button></div>}
          <div className="ar-tabs">{[ 'Live', `Applicable Rules ${sessionRules?.rules?.length ?? 0}`, `Documents ${documents?.total ?? 0}`, ...(closed ? ['Dossier'] : [])].map(t => <button key={t} className="ar-tab" aria-selected={tab === t.split(' ')[0] || tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
          {tab.startsWith('Live') || tab === 'Inspection' ? <>
            <p className="ar-small">Waiting / Receiving / Analyzing / Ready to Close / Finalizing — stage: {current.lifecycleStatus} · Evidence {evidence.length} (video {videos.length} · photos {photos.length} · point cloud {pcs.length})</p>
            <div className="ar-evgrid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <section className="ar-card pad"><h3 className="ar-h3">Video</h3>{videos.length ? videos.map((e: any) => <p key={e.evidenceId} className="ar-mono">{e.filename} · {e.eventId}</p>) : <p className="ar-muted">Awaiting camera</p>}</section>
              <section className="ar-card pad"><h3 className="ar-h3">Point cloud</h3>{pcs.length ? pcs.map((e: any) => <p key={e.evidenceId} className="ar-mono">{e.filename} · {pcs.length} chunks received (not coverage)</p>) : <p className="ar-muted">Awaiting laser scan</p>}</section>
              <section className="ar-card pad"><h3 className="ar-h3">Photographs</h3>{photos.length ? photos.map((e: any) => <p key={e.evidenceId} className="ar-mono">{e.filename}</p>) : <p className="ar-muted">No photographs yet</p>}</section>
              <section className="ar-card pad"><h3 className="ar-h3">CAD reference</h3><p>{current.model_id} · rev {current.cadRevision}</p><p className="ar-mono">{current.cadSha256}</p><p className="ar-small">STEP-derived viewer in reference pack; pinned at creation.</p></section>
            </div>
            <section className="ar-card pad"><h3 className="ar-h3">Live findings</h3>{(sessionRules?.rules || []).map((r: any) => <p key={r.ruleId}>{r.ruleId} — <span className="ar-badge">{r.status}</span> {r.finding?.reason || ''}</p>)}</section>
          </> : tab.startsWith('Applicable') ? <section className="ar-card pad"><p className="ar-small">Library {sessionRules?.cascade?.library} → valve type {sessionRules?.cascade?.valveType} → customer spec {sessionRules?.cascade?.customerSpec}</p><p>{sessionRules?.why}</p>{(sessionRules?.rules || []).map((r: any) => <div key={r.ruleId} className="ar-row static"><span>{r.ruleId} {r.title}</span><span className="ar-badge">{r.status}</span><span className="ar-small">“{r.quote}”</span></div>)}</section>
          : tab.startsWith('Documents') ? <section className="ar-card pad">{(documents?.documents || []).map((d: any, i: number) => <p key={i} className="ar-mono">{d.name} · {d.type} · {d.size} bytes · {d.source}</p>)}</section>
          : <section className="ar-card pad"><p>Dossier ready.</p><a className="ar-btn primary" href={`/api/v1/inspections/${current.id}/dossier`} target="_blank">Open Dossier</a></section>}
        </>}
      </main></div>
    </div>
  );
}
