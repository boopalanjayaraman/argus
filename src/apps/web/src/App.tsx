import { useEffect, useState } from 'react';

const api = (p: string, o?: any) => fetch(p, o).then(r => r.json());
const SEARCH_ICON = 'M10.5 3a7.5 7.5 0 1 0 4.6 13.5l5 5 1.4-1.4-5-5A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z';
const titleCase = (s: string) => (s || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const statusClass = (s: string) => ({ WAITING: 'ar-badge', RECEIVING: 'ar-badge info', ANALYZING: 'ar-badge info', READY_TO_CLOSE: 'ar-badge warn', FINALIZING: 'ar-badge warn', COMPLETED: 'ar-badge pass', TERMINATED: 'ar-badge fail' } as any)[s] || 'ar-badge';
const outcomeClass = (s: string) => ({ PASS: 'ar-badge pass', WARNING: 'ar-badge warn', FAIL: 'ar-badge fail', INCONCLUSIVE: 'ar-badge info', PENDING: 'ar-badge' } as any)[s] || 'ar-badge';
const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const STAGE_BLURB: Record<string, string> = { 'Visual Inspection': 'Checks Argus can make from cameras and scans before delivery.', Identification: 'Markings and identity verified against certificates and orders.', Assembly: 'Assembly, torque and sequence requirements.', 'Functional Testing': 'Tests and functional acceptance from recorded results.', 'Release Gates': 'Checklists that must pass before release.', 'Global Rules': 'Rules that apply across inspections.' };

export default function App() {
  const [page, setPageState] = useState<'home' | 'rules' | 'reports' | 'session'>(() => (location.hash.replace('#', '') as any) in { rules: 1, reports: 1 } ? (location.hash.replace('#', '') as any) : 'home');
  const setPage = (p: typeof page) => { setPageState(p); history.replaceState(null, '', p === 'home' ? location.pathname : `#${p}`); };
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
  const [homeQ, setHomeQ] = useState('');
  const [homeFilter, setHomeFilter] = useState('All');
  const [repQ, setRepQ] = useState('');
  const [repFilter, setRepFilter] = useState('All');
  const [ruleQ, setRuleQ] = useState('');
  const [ruleStage, setRuleStage] = useState('Visual Inspection');
  const [ruleSection, setRuleSection] = useState('');
  const [ruleEv, setRuleEv] = useState('');
  const [openRule, setOpenRule] = useState('');

  const loadHome = () => api('/api/v1/inspections').then(j => setInspections(j.inspections || []));
  useEffect(() => { loadHome(); api('/api/v1/cad-models').then(j => setCadModels(j.cad_models || [])); api('/api/v1/instruction-sets').then(setRules); api('/api/v1/reports').then(j => setReports(j.reports || []));
    const m = location.hash.match(/^#session\/(.+)$/);
    if (m) api(`/api/v1/inspections/${m[1]}`).then(i => { if (i?.id) { setCurrent(i); setPageState('session'); } });
  }, []);
  useEffect(() => { if (page === 'session' && current) { const t = setInterval(async () => { const i = await api(`/api/v1/inspections/${current.id}`); setCurrent(i); setEvidence(await api(`/api/v1/inspections/${current.id}/evidence`)); setSessionRules(await api(`/api/v1/inspections/${current.id}/rules`)); setDocuments(await api(`/api/v1/inspections/${current.id}/documents`)); }, 1500); return () => clearInterval(t); } }, [page, current?.id]);

  const create = async () => { const i = await api('/api/v1/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, model_id: modelId }) }); setCurrent(i); setPage('session'); setTab('Live'); loadHome(); };
  const closeSession = async (term: boolean) => { if (!confirm(term ? 'Terminate now?' : 'End inspection?')) return; const i = await api(`/api/v1/inspections/${current.id}/${term ? 'terminate' : 'close'}`, { method: 'POST' }); setCurrent(i); api('/api/v1/reports').then(j => setReports(j.reports || [])); loadHome(); };

  const filteredInspections = inspections.filter(i => (homeFilter === 'All' || (homeFilter === 'Active' ? !['COMPLETED', 'TERMINATED'].includes(i.lifecycleStatus) : i.lifecycleStatus === homeFilter.toUpperCase())) && (!homeQ || i.name.toLowerCase().includes(homeQ.toLowerCase()) || i.id.includes(homeQ.toLowerCase())));
  const filteredReports = reports.filter(r => (repFilter === 'All' || r.outcome === repFilter.toUpperCase()) && (!repQ || (r.name || '').toLowerCase().includes(repQ.toLowerCase()) || r.sessionId.includes(repQ.toLowerCase())));
  const stageSections = ((rules?.stages || []).find((s: any) => s.name === ruleStage)?.sections || []);
  const visibleSections = stageSections.map((sec: any) => ({ ...sec, rows: (rules?.rules || []).filter((r: any) => r.stage === ruleStage && r.section === sec.name && (!ruleSection || r.section === ruleSection) && (!ruleEv || r.evidence === ruleEv) && (!ruleQ || `${r.code} ${r.title} ${r.text}`.toLowerCase().includes(ruleQ.toLowerCase()))) })).filter((s: any) => s.rows.length);
  const photos = evidence.filter(e => e.mediaType === 'photo'), videos = evidence.filter(e => e.mediaType === 'video'), pcs = evidence.filter(e => e.mediaType === 'pointcloud');
  const totalRules = (sessionRules?.rules || []).filter((r: any) => r.status !== 'NOT_APPLICABLE').length;
  const evaluated = (sessionRules?.rules || []).filter((r: any) => !['NOT_INSPECTED', 'NOT_APPLICABLE', 'ANALYZING'].includes(r.status)).length;
  const findingCounts = { pass: (sessionRules?.rules || []).filter((r: any) => r.status === 'PASS').length, warning: (sessionRules?.rules || []).filter((r: any) => r.status === 'WARNING').length, fail: (sessionRules?.rules || []).filter((r: any) => r.status === 'FAIL').length };
  const closed = current && ['COMPLETED', 'TERMINATED'].includes(current.lifecycleStatus);
  const PHOTO_SLOTS = ['Front flange', 'Bonnet', 'Body', 'Actuator', 'Other flange', 'Linkage'];
  const stageIdx = current ? ({ WAITING: 0, RECEIVING: 1, ANALYZING: 2, READY_TO_CLOSE: 3, FINALIZING: 4 } as any)[current.lifecycleStatus] ?? 5 : 0;
  const stageInfo: string[] = current ? (({
    WAITING: ['Waiting for evidence', 'Nothing received yet. Panels update as files arrive.'],
    RECEIVING: ['Receiving evidence', 'Video is arriving. Checks start when the first photograph and scan land.'],
    ANALYZING: ['Receiving and analyzing', `${evidence.length} files received so far.`],
    READY_TO_CLOSE: ['Ready to close', 'Feed complete and analysis finished. No outcome is final until you end the inspection.'],
    FINALIZING: ['Finalizing report', 'Stopping evidence, freezing findings and generating the dossier.'],
    COMPLETED: ['Completed', `Closed ${current.closedAt ? fmtDate(current.closedAt) : ''}. Evidence and findings are frozen.`],
    TERMINATED: ['Terminated', `Closed ${current.closedAt ? fmtDate(current.closedAt) : ''}. Evidence is partial.`]
  } as Record<string, string[]>)[current.lifecycleStatus] || ['Receiving and analyzing', `${evidence.length} files received so far.`]) : ['', ''];
  const steps = ['Waiting', 'Receiving', 'Analyzing', 'Ready to Close', 'Finalizing'].map((label, i) => ({ label, cls: 'ar-step' + (i < stageIdx ? ' done' : i === stageIdx ? ' on' : '') }));
  const trackState = !current ? '' : current.lifecycleStatus === 'WAITING' ? 'Idle' : closed ? 'Finished' : 'Receiving';
  const tracks = current ? [
    { label: 'camera-01', items: videos, c: '#6D8DBA', state: trackState },
    { label: 'camera-photos-01', items: photos, c: '#D5D8E4', state: trackState },
    { label: 'laser-01', items: pcs, c: '#5AC8D8', state: trackState },
    { label: 'analysis', items: evidence, c: '#A594FF', state: current.lifecycleStatus === 'WAITING' ? 'Idle' : closed ? 'Done' : `${Math.max(0, totalRules - evaluated)} to run` }
  ] : [];
  const liveRules = (sessionRules?.rules || []).filter((r: any) => !['NOT_INSPECTED', 'NOT_APPLICABLE'].includes(r.status));
  const cadFile = (cadModels.find((m: any) => m.model_id === current?.model_id)?.cad_file || '').split('/').pop() || current?.model_id || '';
  const badgeFor = (s: string) => s === 'PASS' ? 'ar-badge pass' : s === 'FAIL' ? 'ar-badge fail' : s === 'WARNING' ? 'ar-badge warn' : 'ar-badge info';


  return (
    <div className="ar-app">
      <header className="ar-top">
        <button type="button" className="ar-logo" onClick={() => setPage('home')} aria-label="Argus home"><svg viewBox="0 0 26 26" fill="none" aria-hidden="true"><circle cx="13" cy="13" r="11.5" stroke="#A594FF" strokeWidth="1.5" /><circle cx="13" cy="13" r="5.5" fill="#A594FF" /><circle cx="15" cy="11" r="1.7" fill="#0A0B10" /></svg>Argus</button>
        <nav className="ar-nav">
          <button type="button" className="ar-navlink" aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}>Home</button>
          <button type="button" className="ar-navlink" aria-current={page === 'rules' ? 'page' : undefined} onClick={() => setPage('rules')}>Inspection Rules</button>
          <button type="button" className="ar-navlink" aria-current={page === 'reports' ? 'page' : undefined} onClick={() => setPage('reports')}>Reports</button>
        </nav>
      </header>

      {page === 'rules' ? (
        <main className="ar-rules">
          <header className="ar-rhead"><div className="ar-rwrap">
            <div className="ar-bar" style={{ gap: '10px 12px' }}>
              <h1 className="ar-h1" style={{ fontSize: 26, marginRight: 12 }}>Inspection Rules</h1>
              <div className="ar-search" style={{ flex: '1 1 280px' }}>
                <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
                <label htmlFor="rule-search" className="ar-sr">Search all rules</label>
                <input id="rule-search" className="ar-input" type="search" placeholder={`Search all ${rules?.counts?.rules ?? 0} rules`} value={ruleQ} onChange={e => setRuleQ(e.target.value)} />
              </div>
              <div style={{ flex: '0 1 176px', minWidth: 150 }}>
                <label htmlFor="rule-type" className="ar-sr">Valve type</label>
                <select id="rule-type" className="ar-select"><option value="">All valve types</option></select>
              </div>
              <div style={{ flex: '0 1 188px', minWidth: 150 }}>
                <label htmlFor="rule-ev" className="ar-sr">Evidence type</label>
                <select id="rule-ev" className="ar-select" value={ruleEv} onChange={e => setRuleEv(e.target.value)}><option value="">All evidence types</option><option>Photo or video</option><option>3D scan</option><option>Measurement</option><option>Functional test</option><option>Work order record</option></select>
              </div>
              {(ruleQ || ruleEv) && <button type="button" className="ar-btn ghost sm" onClick={() => { setRuleQ(''); setRuleEv(''); }}>Clear</button>}
            </div>
            <nav className="ar-stages" aria-label="Rule stages">
              {(rules?.stages || []).map((g: any) => <button key={g.name} type="button" className="ar-stagecard" aria-current={ruleStage === g.name} data-empty={!g.count} onClick={() => { setRuleStage(g.name); setRuleSection(''); }}><span className="ar-h3">{g.name}</span><span className="ar-micro">{g.count} rules</span></button>)}
            </nav>
          </div></header>
          <div className="ar-rbody">
            <nav className="ar-toc" aria-label="Sections">
              <h2 className="ar-h2">{ruleStage}</h2>
              <p className="ar-small" style={{ marginBottom: 12 }}>{STAGE_BLURB[ruleStage] || ''}</p>
              {stageSections.map((s: any) => <button key={s.name} type="button" className="ar-tocitem" aria-current={ruleSection === s.name} onClick={() => setRuleSection(ruleSection === s.name ? '' : s.name)}><span>{s.name}</span><b>{s.count}</b></button>)}
            </nav>
            <div className="ar-rlist">
              {visibleSections.map((sec: any) => <section key={sec.name} className="ar-rsec" aria-label={sec.name}>
                <div className="ar-rsec-head"><h3 className="ar-h3" style={{ fontSize: 15 }}>{sec.name}</h3><span className="ar-micro">{sec.rows.length} rules</span></div>
                {sec.note && <p className="ar-rnote">{sec.note}</p>}
                {sec.rows.map((r: any) => <article key={r.ruleId + r.document} className="ar-rule" data-open={openRule === r.ruleId + r.document}>
                  <button type="button" className="ar-rule-head" aria-expanded={openRule === r.ruleId + r.document} onClick={() => setOpenRule(openRule === r.ruleId + r.document ? '' : r.ruleId + r.document)}>
                    <span className="ar-mono" style={{ color: 'var(--accent)', paddingTop: 1 }}>{r.code}</span>
                    <span className="ar-h3">{r.title}</span>
                    <span className="ar-rule-line">{r.line}</span>
                    <span className="ar-micro">{r.evidence}</span>
                    <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true" style={{ color: '#8D93A8', marginTop: 2 }}><path d="m5 9 7 7 7-7H5Z" /></svg>
                  </button>
                  {openRule === r.ruleId + r.document && <div className="ar-rule-body"><div className="ar-rule-main"><div className="ar-quote" style={{ whiteSpace: 'pre-line', fontSize: 14 }}>{r.text}</div></div>
                    <dl className="ar-dl ar-rule-meta"><dt>Source</dt><dd>{r.source} ({r.document})</dd>{r.reference && <><dt>Reference</dt><dd>{r.reference}</dd></>}<dt>Applies to</dt><dd>{r.stage}</dd></dl></div>}
                </article>)}
              </section>)}
              {!visibleSections.length && <div className="ar-empty"><strong>{rules ? 'No rules match' : 'Loading rules...'}</strong><span>{rules ? 'Try another search or clear the filters.' : ''}</span>{(ruleQ || ruleEv) && <button type="button" className="ar-btn secondary sm" style={{ marginTop: 8 }} onClick={() => { setRuleQ(''); setRuleEv(''); }}>Clear filters</button>}</div>}
            </div>
          </div>
        </main>
      ) : page === 'session' && current ? (
      <>
        <div className="ar-ihead">
          <button type="button" className="ar-link" style={{ minHeight: 24, color: 'var(--text-2)', fontWeight: 500 }} onClick={() => setPage('home')}><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6V6Z" /></svg>Inspections</button>
          <div className="ar-bar">
            <h1 className="ar-h2" style={{ fontSize: 22 }}>{current.name}</h1>
            <span className={statusClass(current.lifecycleStatus)}>{current.lifecycleStatus === 'WAITING' ? '● ' : ''}{titleCase(current.lifecycleStatus)}</span>
            <span className="ar-mono ar-micro">{current.id}</span>
            <button type="button" className="ar-btn ghost sm icon-only" aria-label="Copy session ID" onClick={() => navigator.clipboard?.writeText(current.id)}><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h11v13H8zM5 3h11v4H5z" /></svg></button>
            <div className="ar-spacer" />
            {!closed && <>
              <label htmlFor="ev-file" className="ar-btn secondary"><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3h2v10.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2V3ZM5 20h14v2H5Z" transform="rotate(180 12 12)" /></svg>Upload Evidence</label>
              <input id="ev-file" className="ar-sr" type="file" multiple accept=".mp4,.jpg,.jpeg,.png,.ply,.pcd" onChange={async e => { for (const f of Array.from(e.target.files || [])) { const ext = f.name.split('.').pop()?.toLowerCase(); const ep = ext === 'mp4' ? 'video' : ext === 'ply' || ext === 'pcd' ? 'pointcloud' : 'photos'; const form = new FormData(); form.append('metadata', JSON.stringify({ schemaVersion: '1.0', eventId: `manual-${Date.now()}-${f.name}`, sourceId: 'manual-upload', sequence: 1, relativeTimeMs: 0, mediaType: ep === 'photos' ? 'photo' : ep, synthetic: false, ...(ep === 'pointcloud' ? { units: 'mm', coordinateFrame: 'scanner_local' } : {}) })); form.append('file', f); await fetch(`/api/v1/inspections/${current.id}/${ep}`, { method: 'POST', body: form }); } }} />
              <button type="button" className="ar-btn secondary" onClick={() => closeSession(false)}>End Inspection</button>
              <button type="button" className="ar-btn danger" onClick={() => closeSession(true)}>Terminate Now</button>
            </>}
          </div>
          <div className="ar-tabs" role="tablist" aria-label="Inspection sections">
            {[closed ? 'Inspection' : 'Live', 'Applicable Rules', 'Documents'].map((l: string) => <button key={l} type="button" className="ar-tab" role="tab" aria-selected={tab === l || (l !== 'Applicable Rules' && l !== 'Documents' && tab === 'Live')} onClick={() => setTab(l === 'Applicable Rules' || l === 'Documents' ? l : 'Live')}>{l} <b>{l === 'Applicable Rules' ? (sessionRules?.rules || []).length : l === 'Documents' ? (documents?.total ?? evidence.length) : ''}</b></button>)}
            {closed && <button type="button" className="ar-tab" role="tab" aria-selected={tab === 'Dossier'} onClick={() => setTab('Dossier')}>Dossier</button>}
          </div>
        </div>

        {tab === 'Applicable Rules' ? <div className="ar-scroll"><main className="ar-page"><section className="ar-card pad"><p className="ar-small">Library {sessionRules?.cascade?.library} → valve type {sessionRules?.cascade?.valveType} → customer spec {sessionRules?.cascade?.customerSpec}</p><p>{sessionRules?.why}</p>{(sessionRules?.rules || []).map((r: any) => <div key={r.ruleId} className="ar-row static"><span>{r.section} {r.title}</span><span className={badgeFor(r.status)}>{titleCase(r.status)}</span><span className="ar-small">“{r.quote}”</span></div>)}</section></main></div>
        : tab === 'Documents' ? <div className="ar-scroll"><main className="ar-page"><section className="ar-card pad">{(documents?.documents || []).length ? (documents.documents).map((d: any, i: number) => <p key={i} className="ar-mono">{d.name} · {d.type} · {d.size} bytes · {d.source}</p>) : <div className="ar-empty"><strong>No documents to display</strong><span>Evidence and reports for this inspection will appear here as they arrive.</span></div>}</section></main></div>
        : tab === 'Dossier' ? <div className="ar-scroll"><main className="ar-page"><section className="ar-card pad"><p>Dossier ready.</p><a className="ar-btn primary" href={`/api/v1/inspections/${current.id}/dossier`} target="_blank" rel="noreferrer">Open Dossier</a></section></main></div>
        : <div className={`ar-live${closed ? ' closed' : ''}`}>
          <div className="ar-evidence" aria-label="Evidence">
            <div className="ar-bar" style={{ flex: 'none', justifyContent: 'space-between', gap: 8, minHeight: 30 }}>
              <h2 className="ar-h3">Evidence <span className="ar-micro" style={{ marginLeft: 4 }}>{evidence.length} {evidence.length === 1 ? 'file' : 'files'}</span></h2>
            </div>
            <div className="ar-evgrid">
              <section className="ar-media" aria-label="Video">
                <span className="ar-media-tag">Video</span><span className="ar-media-meta">{videos.length ? `${videos[videos.length - 1].sourceId}` : 'camera-01 idle'}</span>
                {videos.length ? <video key={videos[videos.length - 1].evidenceId} src={`/api/v1/inspections/${current.id}/evidence/${videos[videos.length - 1].evidenceId}/file`} controls muted playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} /> : <div className="ar-media-empty">{closed ? 'No video received' : 'Awaiting camera'}</div>}
              </section>
              <section className="ar-media" aria-label="3D point cloud" style={{ background: '#07080C' }}>
                <span className="ar-media-tag">Point cloud</span><span className="ar-media-meta">{pcs.length ? `${pcs.length} chunks` : 'laser-01 idle'}</span>
                {pcs.length ? <div style={{ position: 'absolute', inset: '44px 12px 12px', overflow: 'hidden', textAlign: 'center' }}><p className="ar-h3">{pcs.length} point-cloud chunks received</p><p className="ar-small">Chunk count is not surface coverage. Registration quality appears with findings.</p>{pcs.slice(-4).map((e: any) => <p key={e.evidenceId} className="ar-mono ar-micro">{e.filename}</p>)}</div> : <div className="ar-media-empty">{closed ? 'No scan received' : 'Awaiting laser scan'}</div>}
              </section>
              <section className="ar-media" aria-label="Photographs">
                <span className="ar-media-tag">Photographs</span><span className="ar-media-meta">{photos.length} of 6</span>
                <div className="ar-photos">
                  {PHOTO_SLOTS.map((label, i) => photos[i]
                    ? <span key={label} className="ar-photo"><img src={`/api/v1/inspections/${current.id}/evidence/${photos[i].evidenceId}/file`} alt={label} /></span>
                    : <div key={label} className="ar-photo empty">{label}</div>)}
                </div>
              </section>
              <section className="ar-media" aria-label="CAD reference" style={{ background: '#07080C' }}>
                <span className="ar-media-tag">CAD reference</span><span className="ar-media-meta">{cadFile}</span>
                <div className="ar-stagebox"><div className="ar-4x3"><img src="/assets/27eb1fb0b3044c82e23e2ffd10ff5ad6.svg" alt="Wireframe reference model of the valve" /></div></div>
              </section>
            </div>
            <section className="ar-card" aria-label="Timeline and source state" style={{ flex: 'none', padding: '12px 16px' }}>
              <div className="ar-bar" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <h2 className="ar-h3">Timeline</h2>
                <span className="ar-micro">{current.lifecycleStatus === 'WAITING' ? 'Session open, feeds idle' : closed ? 'Feed complete' : 'Synthetic source'}</span>
              </div>
              <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 520, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {tracks.map((tk: any) => <div key={tk.label} className="ar-track">
                  <span className="ar-mono ar-micro">{tk.label}</span>
                  <div className="ar-lane">{tk.items.map((e: any) => <i key={e.evidenceId} style={{ left: `${Math.min(96, ((e.relativeTimeMs || 0) / 40000) * 100)}%`, background: tk.c }} />)}</div>
                  <span className="ar-micro">{tk.state}</span>
                </div>)}
              </div></div>
            </section>
          </div>

          <aside className="ar-panel" aria-label="Inspection stage and findings">
            <section className="ar-stage" aria-label="Current stage">
              <ol className="ar-steps">
                {steps.map((s: any) => <li key={s.label} className={s.cls}><i></i>{s.label}</li>)}
              </ol>
              <div role="status">
                <div className="ar-h2">{stageInfo[0]}</div>
                <div className="ar-small">{stageInfo[1]}</div>
              </div>
              {current.lifecycleStatus !== 'WAITING' && current.lifecycleStatus !== 'RECEIVING' && <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div className="ar-meter"><i style={{ width: `${totalRules ? Math.round((evaluated / totalRules) * 100) : 0}%` }}></i></div>
                <span className="ar-micro">{evaluated} of {totalRules} applicable rules evaluated</span>
              </div>}
              {current.lifecycleStatus === 'WAITING' && <button type="button" className="ar-btn secondary sm" onClick={() => window.open(`http://${location.hostname}:4173`, '_blank')}>Prototype: run simulated feed</button>}
              {closed && <div className="ar-bar" style={{ justifyContent: 'space-between' }}>
                <span className={outcomeClass(current.outcome)}>Outcome: {titleCase(current.outcome)}</span>
                <a className="ar-btn secondary sm" href={`/api/v1/inspections/${current.id}/dossier`} target="_blank" rel="noreferrer">Open Dossier</a>
              </div>}
            </section>
            {!closed && <>
              <div className="ar-feedhead">
                <h2 className="ar-h3">Live findings</h2>
                <div className="ar-bar" style={{ gap: '4px 10px' }}>
                  <span className="ar-micro" style={{ color: 'var(--pass)', fontWeight: 600 }}>{findingCounts.pass} Pass</span>
                  <span className="ar-micro" style={{ color: 'var(--warn)', fontWeight: 600 }}>{findingCounts.warning} Warning</span>
                  <span className="ar-micro" style={{ color: findingCounts.fail ? 'var(--fail)' : 'var(--text-3)', fontWeight: 600 }}>{findingCounts.fail} Fail</span>
                </div>
              </div>
              <div className="ar-feed">
                {liveRules.slice(0, 8).map((r: any) => <article key={r.ruleId} className="ar-finding" data-open="false">
                  <div className="ar-finding-head" style={{ cursor: 'default' }}>
                    <span style={{ minWidth: 0 }}>
                      <span className="ar-finding-meta"><span className={badgeFor(r.status)}>{titleCase(r.status)}</span><span className="ar-mono ar-micro">Rule {r.section}</span></span>
                      <span className="ar-finding-title">{r.title}</span>
                      <span className="ar-finding-cap">{r.finding?.reason || 'Evidence received. Comparing it with the rule.'}</span>
                    </span>
                  </div>
                </article>)}
                {!liveRules.length && <div className="ar-empty" style={{ padding: '32px 20px' }}>
                  <strong>No checks evaluated yet</strong>
                  <span>Send evidence to session <span className="ar-mono">{current.id}</span>. Findings appear here as checks finish.</span>
                  <button type="button" className="ar-btn secondary sm" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(current.id)}>Copy session ID</button>
                </div>}
              </div>
            </>}
          </aside>

          {closed && <section className="ar-reader" aria-labelledby="final-heading">
            <div className="ar-reader-head">
              <h2 id="final-heading" className="ar-h2" style={{ fontSize: 20 }}>Final findings</h2>
              <div className="ar-bar" style={{ gap: '4px 12px' }}>
                <span className="ar-small" style={{ color: 'var(--pass)', fontWeight: 600 }}>{findingCounts.pass} Pass</span>
                <span className="ar-small" style={{ color: 'var(--warn)', fontWeight: 600 }}>{findingCounts.warning} Warning</span>
                <span className="ar-small" style={{ color: findingCounts.fail ? 'var(--fail)' : 'var(--text-3)', fontWeight: 600 }}>{findingCounts.fail} Fail</span>
              </div>
            </div>
            {(sessionRules?.rules || []).map((r: any) => <article key={r.ruleId} className="ar-read">
              <div className="ar-read-head" style={{ cursor: 'default' }}>
                <span><span className={badgeFor(r.status)}>{titleCase(r.status)}</span></span>
                <span style={{ minWidth: 0 }}><span className="ar-read-title">{r.title}</span><span className="ar-read-cap">{r.finding?.reason || 'Not evaluated.'}</span></span>
                <span className="ar-mono ar-micro" style={{ paddingTop: 3 }}>Rule {r.section}</span>
                <span className="ar-mono ar-micro" style={{ paddingTop: 3 }}></span>
                <span></span>
              </div>
            </article>)}
          </section>}
        </div>}
      </>

      ) : (
      <div className="ar-scroll"><main className="ar-page">
      {page === 'home' && <>
        <div><h1 className="ar-h1">Autonomous Industrial Inspection</h1>
        <p className="ar-lead">Live video, photographs and laser scans, checked against approved CAD and inspection rules.</p></div>
        <div className="ar-split">
          <section className="ar-card ar-grow" aria-labelledby="ins-heading" style={{ overflow: 'hidden' }}>
            <div className="ar-bar" style={{ padding: '18px 20px' }}>
              <h2 id="ins-heading" className="ar-h2">Inspections</h2><div className="ar-spacer" />
              <div className="ar-search" style={{ flex: '0 1 260px' }}>
                <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
                <label htmlFor="home-search" className="ar-sr">Search inspections</label>
                <input id="home-search" className="ar-input" type="search" placeholder="Search inspections" value={homeQ} onChange={e => setHomeQ(e.target.value)} />
              </div>
            </div>
            <div className="ar-chips" style={{ padding: '0 20px 14px' }}>
              {[['All', inspections.length], ['Active', inspections.filter(i => !['COMPLETED', 'TERMINATED'].includes(i.lifecycleStatus)).length], ['Completed', inspections.filter(i => i.lifecycleStatus === 'COMPLETED').length], ['Terminated', inspections.filter(i => i.lifecycleStatus === 'TERMINATED').length]].map(([l, n]: any) => <button key={l} type="button" className="ar-chip" aria-pressed={homeFilter === l} onClick={() => setHomeFilter(l)}>{l} <b>{n}</b></button>)}
            </div>
            <div className="ar-rows"><div style={{ minWidth: 780 }}>
              <div className="ar-rowhead" style={{ gridTemplateColumns: 'minmax(200px,2fr) 150px 112px 104px minmax(150px,1.3fr) 16px' }}><span>Inspection</span><span>Started</span><span>Session</span><span>Outcome</span><span>Findings</span><span></span></div>
              {filteredInspections.map(i => {
                const f = i.findings || { pass: 0, warning: 0, fail: 0, insufficient: 0, unchecked: 0, total: 0 };
                const seg = [[f.pass, '#4BE0A0'], [f.warning, '#FFC554'], [f.fail, '#FF7468'], [f.insufficient, '#7AB8FF'], [f.unchecked, '#3A4152']].filter(([n]: any) => n > 0);
                return <button key={i.id} type="button" className="ar-row" style={{ gridTemplateColumns: 'minmax(200px,2fr) 150px 112px 104px minmax(150px,1.3fr) 16px' }} onClick={() => { setCurrent(i); setPage('session'); }}>
                  <span style={{ minWidth: 0 }}><span className="ar-h3" style={{ display: 'block' }}>{i.name}</span><span className="ar-mono ar-micro">{i.id}</span></span>
                  <span className="ar-small">{fmtDate(i.createdAt)}</span>
                  <span><span className={statusClass(i.lifecycleStatus)}>{titleCase(i.lifecycleStatus)}</span></span>
                  <span><span className={outcomeClass(i.outcome)}>{titleCase(i.outcome)}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{f.total ? <><span className="ar-minibar">{seg.map(([n, c]: any, k: number) => <span key={k} style={{ flex: `${n} 1 0`, background: c }} />)}</span><span className="ar-micro">{[f.pass && `${f.pass} Pass`, f.warning && `${f.warning} Warning`, f.fail && `${f.fail} Fail`, f.insufficient && `${f.insufficient} Insufficient`, f.unchecked && `${f.unchecked} Unchecked`].filter(Boolean).join(' · ')}</span></> : <span className="ar-micro">No findings yet</span>}</span>
                  <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true" style={{ color: '#8D93A8' }}><path d="m9 5 7 7-7 7V5Z" /></svg>
                </button>;
              })}
            </div></div>
            {!filteredInspections.length && (inspections.length ? <div className="ar-empty"><strong>No inspections match</strong><span>Try another name or clear the filter.</span></div> : <div className="ar-empty"><strong>No inspections to display</strong><span>Create one using Start inspection to get started.</span></div>)}
          </section>
          <form className="ar-card pad ar-side" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} aria-labelledby="start-heading" onSubmit={e => e.preventDefault()}>
            <h2 id="start-heading" className="ar-h2">Start inspection</h2>
            <div className="ar-field"><label htmlFor="start-name">Inspection name</label>
              <input id="start-name" className="ar-input" type="text" placeholder="e.g. CVS 6000D — Blue Valve Run" value={name} onChange={e => setName(e.target.value)} /></div>
            <div className="ar-field"><label htmlFor="cad-model">CAD model</label>
              <select id="cad-model" className="ar-select" value={modelId} onChange={e => setModelId(e.target.value)}>{cadModels.map(m => <option key={m.model_id} value={m.model_id}>{m.display_name}</option>)}</select></div>
            <div className="ar-field"><span className="ar-label">Customer specification or work order (optional)</span>
              <label htmlFor="spec-file" className="ar-drop"><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3h2v10.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2V3ZM5 20h14v2H5Z" /></svg><span><strong>Upload specification</strong><span className="ar-small">PDF, Word or Excel</span></span></label>
              <input id="spec-file" className="ar-sr" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx" /></div>
            <dl className="ar-dl"><dt>Valve type</dt><dd>{cadModels.find(m => m.model_id === modelId)?.display_name || 'CVS 6000D'}</dd><dt>Rules</dt><dd>Selected from the valve type and this document</dd></dl>
            <button type="button" className="ar-btn primary" disabled={!name.trim()} onClick={create}>Start Inspection</button>
          </form>
        </div></>}

      {page === 'reports' && <>
        <div><h1 className="ar-h1">Reports</h1>
        <p className="ar-lead">Inspection dossiers, generated when an inspection is ended or terminated.</p></div>
        <section className="ar-card" aria-label="All reports" style={{ overflow: 'hidden' }}>
          <div className="ar-bar" style={{ padding: '18px 20px' }}>
            <div className="ar-chips">
              {[['All', reports.length], ['Pass', reports.filter(r => r.outcome === 'PASS').length], ['Warning', reports.filter(r => r.outcome === 'WARNING').length], ['Fail', reports.filter(r => r.outcome === 'FAIL').length], ['Inconclusive', reports.filter(r => r.outcome === 'INCONCLUSIVE').length]].map(([l, n]: any) => <button key={l} type="button" className="ar-chip" aria-pressed={repFilter === l} onClick={() => setRepFilter(l)}>{l} <b>{n}</b></button>)}
            </div><div className="ar-spacer" />
            <div className="ar-search" style={{ flex: '0 1 280px' }}>
              <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
              <label htmlFor="rep-search" className="ar-sr">Search reports</label>
              <input id="rep-search" className="ar-input" type="search" placeholder="Search reports" value={repQ} onChange={e => setRepQ(e.target.value)} />
            </div>
          </div>
          <div className="ar-rows"><div style={{ minWidth: 860 }}>
            <div className="ar-rowhead" style={{ gridTemplateColumns: 'minmax(220px,2fr) 150px 90px 110px minmax(140px,1fr) 190px' }}><span>Report</span><span>Closed</span><span>Type</span><span>Outcome</span><span>Findings</span><span></span></div>
            {filteredReports.map((r: any) => <div key={r.sessionId} className="ar-row static" style={{ gridTemplateColumns: 'minmax(220px,2fr) 150px 90px 110px minmax(140px,1fr) 190px' }}>
              <span style={{ minWidth: 0 }}><span className="ar-h3" style={{ display: 'block' }}>{r.name}</span><span className="ar-mono ar-micro">{r.sessionId}</span></span>
              <span className="ar-small">{fmtDate(r.closedAt)}</span>
              <span className="ar-small">{r.type}</span>
              <span><span className={outcomeClass(r.outcome)}>{titleCase(r.outcome)}</span></span>
              <span className="ar-micro">{r.findings?.total ? ([r.findings.pass && `${r.findings.pass} Pass`, r.findings.warning && `${r.findings.warning} Warning`, r.findings.fail && `${r.findings.fail} Fail`].filter(Boolean).join(' · ') || 'No passed checks yet') : 'No findings yet'}</span>
              <span className="ar-bar" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <a className="ar-btn secondary sm" href={`/api/v1/inspections/${r.sessionId}/dossier`} target="_blank" rel="noreferrer">View</a>
                <a className="ar-btn ghost sm" href={`/api/v1/inspections/${r.sessionId}/dossier`} download={`dossier-${r.sessionId}.html`}>Download</a>
              </span></div>)}
          </div></div>
          {!filteredReports.length && (reports.length ? <div className="ar-empty"><strong>No reports match</strong><span>Try another name or clear the filter.</span></div> : <div className="ar-empty"><strong>No reports to display</strong><span>Complete an inspection and its dossier will appear here. Create one from Home to get started.</span></div>)}
        </section></>}

      </main></div>)}
    </div>
  );
}
