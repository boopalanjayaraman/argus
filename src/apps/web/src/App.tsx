import { useEffect, useRef, useState } from 'react';
import { lazy, Suspense } from 'react';
import type { Viewer } from './ViewerDialog';
const ViewerDialog = lazy(() => import('./ViewerDialog'));
const PointCloudThumb = lazy(() => import('./PointCloudThumb'));
const ExpandIcon = () => (<svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-6 6M4 20l6-6" /></svg>);

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
  const [history, setHistory] = useState<any>(null);
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
  const [docQ, setDocQ] = useState('');
  const [docFilter, setDocFilter] = useState('All');
  const [openApp, setOpenApp] = useState('');
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [openRead, setOpenRead] = useState<Record<string, boolean>>({});
  const [specFile, setSpecFile] = useState<File | null>(null);
  const [formNote, setFormNote] = useState('');
  const [specNote, setSpecNote] = useState('');

  const loadHome = () => api('/api/v1/inspections').then(j => setInspections(j.inspections || []));
  useEffect(() => { loadHome(); api('/api/v1/cad-models').then(j => setCadModels(j.cad_models || [])); api('/api/v1/instruction-sets').then(setRules); api('/api/v1/reports').then(j => setReports(j.reports || []));
    const m = location.hash.match(/^#session\/([^/]+)(?:\/(rules|documents|dossier|previous|photo|video|video-analyzed|pointcloud|cad))?$/);
    if (m) api(`/api/v1/inspections/${m[1]}`).then(i => { if (i?.id) { setCurrent(i); setPageState('session'); if (m[2] === 'rules') setTab('Applicable Rules'); else if (m[2] === 'documents') setTab('Documents'); else if (m[2] === 'dossier') setTab('Dossier'); else if (m[2] === 'previous') setTab('Previous Inspections'); else if (m[2] === 'photo') setViewer({ kind: 'photo', index: 0 }); else if (m[2] === 'video') setViewer({ kind: 'video' }); else if (m[2] === 'video-analyzed') setViewer({ kind: 'video', tab: 'analyzed' }); else if (m[2] === 'pointcloud') setViewer({ kind: 'pointcloud' }); else if (m[2] === 'cad') setViewer({ kind: 'cad' }); } });
  }, []);
  // Live session: server-sent events drive refreshes (EventSource resumes
  // with Last-Event-ID after a drop); a slow poll reconciles if SSE is blocked.
  useEffect(() => {
    if (page !== 'session' || !current) return;
    const id = current.id; let stopped = false; let timer: any = null;
    const load = async () => {
      // Each part refreshes on its own: one failed request must not freeze
      // the page on its last state (a stale "Analyzing" was seen in the cloud).
      const [i, ev, rs, docs, hist] = await Promise.allSettled([api(`/api/v1/inspections/${id}`), api(`/api/v1/inspections/${id}/evidence`), api(`/api/v1/inspections/${id}/rules`), api(`/api/v1/inspections/${id}/documents`), api(`/api/v1/inspections/${id}/history`)]);
      if (stopped) return;
      const ok = (r: PromiseSettledResult<any>) => r.status === 'fulfilled' && r.value && !r.value.error;
      if (ok(i)) setCurrent((i as any).value);
      if (ok(ev) && Array.isArray((ev as any).value)) setEvidence((ev as any).value);
      if (ok(rs)) setSessionRules((rs as any).value);
      if (ok(docs)) setDocuments((docs as any).value);
      if (ok(hist)) setHistory((hist as any).value);
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => { load().catch(() => {}); }, 200); };
    load().catch(() => {});
    // A closed session is frozen: no live stream, just the slow reconciliation poll.
    const es = ['COMPLETED', 'TERMINATED'].includes(current.lifecycleStatus) ? null : new EventSource(`/api/v1/inspections/${id}/events`);
    if (es) es.onmessage = soon;
    const poll = setInterval(() => { load().catch(() => {}); }, 10000);
    return () => { stopped = true; es?.close(); clearInterval(poll); clearTimeout(timer); };
  }, [page, current?.id]);

  // Findings that arrive while the page is open get a short highlight;
  // what was already there when the session opened does not flash.
  // Home keeps its list current (lifecycle, outcome, findings) while open.
  useEffect(() => {
    if (page !== 'home') return;
    loadHome().catch(() => {});
    const t = setInterval(() => { loadHome().catch(() => {}); }, 10000);
    return () => clearInterval(t);
  }, [page]);

  // Tracked during render (idempotent), so a new finding is drawn
  // highlighted on the very render that first shows it.
  const seen = useRef<{ session: string; ready: boolean; fresh: Set<string>; known: Set<string> }>({ session: '', ready: false, fresh: new Set(), known: new Set() });
  if (current && sessionRules && String(sessionRules.snapshot?.snapshotId || '').startsWith(`ref-${current.id}-`)) {
    const st = seen.current;
    if (st.session !== current.id) { st.session = current.id; st.ready = false; st.fresh = new Set(); st.known = new Set(); }
    for (const r of (sessionRules.rules || [])) {
      if (!r.finding) continue;
      const k = `${r.ruleId}:${r.finding.revision ?? 0}`;
      if (!st.known.has(k)) { st.known.add(k); if (st.ready) st.fresh.add(k); }
    }
    st.ready = true;
  }

  const create = async () => {
    setFormNote('');
    let r: Response;
    if (specFile) { const f = new FormData(); f.append('name', name); f.append('model_id', modelId); f.append('file', specFile); r = await fetch('/api/v1/inspections', { method: 'POST', body: f }); }
    else r = await fetch('/api/v1/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, model_id: modelId }) });
    const i = await r.json();
    if (!r.ok) { setFormNote(i?.error?.message || 'Could not start the inspection.'); return; }
    setSpecFile(null); setCurrent(i); setPage('session'); setTab('Live'); loadHome();
  };
  const attachSpec = async (file: File | undefined) => {
    if (!file || !current) return;
    setSpecNote('Reading the document\u2026');
    const f = new FormData(); f.append('file', file);
    const r = await fetch(`/api/v1/inspections/${current.id}/order-document`, { method: 'POST', body: f }); const j = await r.json();
    setSpecNote(!r.ok ? (j?.error?.message || 'Upload failed.') : j.document?.extraction?.status === 'parsed' ? `${j.cascade.orderRules} order rules added from ${j.document.name}.` : `${j.document?.name} stored, but no rules could be read from it.`);
    setSessionRules(await api(`/api/v1/inspections/${current.id}/rules`)); setDocuments(await api(`/api/v1/inspections/${current.id}/documents`));
  };
  const closeSession = async (term: boolean) => { if (!confirm(term ? 'Terminate now?' : 'End inspection?')) return; const i = await api(`/api/v1/inspections/${current.id}/${term ? 'terminate' : 'close'}`, { method: 'POST' }); setCurrent(i); api('/api/v1/reports').then(j => setReports(j.reports || [])); loadHome(); };

  const filteredInspections = inspections.filter(i => (homeFilter === 'All' || (homeFilter === 'Active' ? !['COMPLETED', 'TERMINATED'].includes(i.lifecycleStatus) : i.lifecycleStatus === homeFilter.toUpperCase())) && (!homeQ || i.name.toLowerCase().includes(homeQ.toLowerCase()) || i.id.includes(homeQ.toLowerCase())));
  // Inspections of the same work order / asset are listed together, in stage
  // (creation) order; groups follow their newest inspection. Display only.
  const homeGroups = (() => {
    const map = new Map<string, any[]>(); const keys: string[] = [];
    for (const i of filteredInspections) { const k = i.groupKey || `solo:${i.id}`; if (!map.has(k)) { map.set(k, []); keys.push(k); } map.get(k)!.push(i); }
    return keys.map(k => ({ key: k.startsWith('solo:') ? '' : k, items: map.get(k)!.slice().sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt)) })).map((g, n) => ({ ...g, key: g.key || `solo-${n}` }));
  })();
  const filteredReports = reports.filter(r => (repFilter === 'All' || r.outcome === repFilter.toUpperCase()) && (!repQ || (r.name || '').toLowerCase().includes(repQ.toLowerCase()) || r.sessionId.includes(repQ.toLowerCase())));
  const stageSections = ((rules?.stages || []).find((s: any) => s.name === ruleStage)?.sections || []);
  const visibleSections = stageSections.map((sec: any) => ({ ...sec, rows: (rules?.rules || []).filter((r: any) => r.stage === ruleStage && r.section === sec.name && (!ruleSection || r.section === ruleSection) && (!ruleEv || r.evidence === ruleEv) && (!ruleQ || `${r.code} ${r.title} ${r.text}`.toLowerCase().includes(ruleQ.toLowerCase()))) })).filter((s: any) => s.rows.length);
  const photos = evidence.filter(e => e.mediaType === 'photo'), videos = evidence.filter(e => e.mediaType === 'video'), pcs = evidence.filter(e => e.mediaType === 'pointcloud');
  const totalRules = (sessionRules?.rules || []).filter((r: any) => r.status !== 'NOT_APPLICABLE').length;
  const evaluated = (sessionRules?.rules || []).filter((r: any) => !['NOT_INSPECTED', 'NOT_APPLICABLE', 'ANALYZING'].includes(r.status)).length;
  const findingCounts = { pass: (sessionRules?.rules || []).filter((r: any) => r.status === 'PASS').length, warning: (sessionRules?.rules || []).filter((r: any) => r.status === 'WARNING').length, fail: (sessionRules?.rules || []).filter((r: any) => r.status === 'FAIL').length };
  const closed = current && ['COMPLETED', 'TERMINATED'].includes(current.lifecycleStatus);
  const PHOTO_SLOTS = ['Front flange', 'Bonnet', 'Body', 'Actuator', 'Other flange', 'Linkage'];
  const photoOffset = Math.max(0, photos.length - PHOTO_SLOTS.length);
  const stageIdx = current ? ({ WAITING: 0, RECEIVING: 1, ANALYZING: 2, READY_TO_CLOSE: 3, FINALIZING: 4 } as any)[current.lifecycleStatus] ?? 5 : 0;
  const stageInfo: string[] = current ? (({
    WAITING: ['Waiting for evidence', 'Nothing received yet. Panels update as files arrive.'],
    RECEIVING: ['Receiving evidence', 'Video is arriving. Checks start when the first photograph and scan land.'],
    ANALYZING: ['Receiving and analyzing', `${evidence.length} files received · ${current.analysis?.pending ?? 0} being analysed now.`],
    READY_TO_CLOSE: ['Ready to close', 'Feed complete and analysis finished. Closing automatically; video annotations continue in the background.'],
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
    { label: 'analysis', items: evidence.filter((e: any) => e.processingStatus === 'done'), c: '#A594FF', state: current.lifecycleStatus === 'WAITING' ? 'Idle' : closed ? 'Done' : current.analysis?.pending ? `${current.analysis.pending} running` : 'Idle' }
  ] : [];
  // Live feed: newest result first, so a fresh finding is always in view.
  const liveRules = (sessionRules?.rules || []).filter((r: any) => !['NOT_INSPECTED', 'NOT_APPLICABLE'].includes(r.status))
    .sort((a: any, b: any) => String(b.finding?.at || '').localeCompare(String(a.finding?.at || '')));
  const sinceStart = (iso?: string) => { if (!iso || !current) return ''; const s = Math.max(0, Math.round((new Date(iso).getTime() - new Date(current.createdAt).getTime()) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const feedKey = (r: any) => `${r.ruleId}:${r.finding?.revision ?? 0}`;
  const analyzingNow = evidence.filter((e: any) => e.processingStatus === 'processing');
  const geo: any = current?.geometry || null;
  const geoText = !geo ? '' : geo.status === 'running' ? 'Comparing with CAD\u2026'
    : geo.status === 'valid' ? `Comparison succeeded${geo.coverage !== undefined ? ` \u00B7 Coverage ${Math.round(geo.coverage * 100)}%` : ''}`
    : geo.status === 'insufficient' ? `Comparison did not validate \u00B7 ${geo.reason || 'registration not validated'}`
    : `Comparison unavailable \u00B7 ${geo.reason || 'inspection service unreachable'}`;
  const cadFile = (cadModels.find((m: any) => m.model_id === current?.model_id)?.cad_file || '').split('/').pop() || current?.model_id || '';
  const fmtSize = (n: number) => !n ? '0 KB' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  const statusLabel = (s: string) => ({ NOT_INSPECTED: 'Pending', ANALYZING: 'Analyzing', INSUFFICIENT_EVIDENCE: 'Insufficient Evidence', NOT_APPLICABLE: 'Not Applicable' } as any)[s] || titleCase(s);
  const evLabel = (r: any) => [...new Set((r.modalities || []).map((m: string) => m === 'pointcloud' ? '3D scan' : 'Photo or video'))].join(' \u00B7 ');
  const docKind = (d: any) => d.kind || ({ video: 'Video', photo: 'Photograph', pointcloud: 'Point cloud' } as any)[d.type] || d.type;
  const isSpec = (d: any) => ['cad', 'rules', 'order'].includes(d.type);
  const docCat = (d: any) => d.type === 'Report' ? 'Reports' : isSpec(d) ? 'Specifications' : d.type === 'video' ? 'Video' : d.type === 'photo' ? 'Photographs' : 'Point clouds';
  const allDocs: any[] = [...(documents?.documents || [])].sort((a: any, b: any) => ((a.type === 'Report' ? 0 : isSpec(a) ? 1 : 2) - (b.type === 'Report' ? 0 : isSpec(b) ? 1 : 2)));
  const docRows = allDocs.filter((d: any) => (docFilter === 'All' || docCat(d) === docFilter) && (!docQ || d.name.toLowerCase().includes(docQ.toLowerCase())));
  const leftOut = (sessionRules?.rules || []).filter((r: any) => r.status === 'NOT_APPLICABLE');
  const appRules = (sessionRules?.rules || []).filter((r: any) => r.status !== 'NOT_APPLICABLE');
  const ruleSections = [...new Set<string>(appRules.map((r: any) => r.section || 'Rules'))].map((name) => ({ name, rows: appRules.filter((r: any) => (r.section || 'Rules') === name) }));
  const ruleNo = (r: any) => r.code || r.ruleId;
  // Dossier export is a PDF prepared by the ReportAgent at closure.
  const pdfDownload = (sessionId: string) => { const a = document.createElement('a'); a.href = `/api/v1/inspections/${sessionId}/dossier.pdf`; a.download = `${sessionId}_dossier.pdf`; a.click(); };
  const downloadDossier = () => pdfDownload(current.id);
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
              <h1 className="ar-h1" style={{ fontSize: 26, marginRight: 4 }}>Inspection Rules</h1>
              <span className="ar-badge plain" style={{ marginRight: 12 }}>{rules?.counts?.rules ?? 0} rules · {rules?.counts?.documents ?? 0} documents</span>
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
                  {openRule === r.ruleId + r.document && <div className="ar-rule-body"><div className="ar-rule-main"><div className="ar-quote" style={{ whiteSpace: 'pre-line', fontSize: 14, overflowWrap: 'anywhere' }}>{r.text}</div></div>
                    <dl className="ar-dl ar-rule-meta" style={{ minWidth: 0, overflowWrap: 'anywhere' }}><dt>Source</dt><dd>{r.source} ({r.document})</dd>{r.reference && <><dt>Reference</dt><dd>{r.reference}</dd></>}<dt>Applies to</dt><dd>{r.stage}</dd></dl></div>}
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
            {[closed ? 'Inspection' : 'Live', 'Applicable Rules', 'Documents', ...(history?.previous?.length ? ['Previous Inspections'] : [])].map((l: string) => <button key={l} type="button" className="ar-tab" role="tab" aria-selected={tab === l || ((l === 'Live' || l === 'Inspection') && tab === 'Live')} onClick={() => setTab(l === 'Inspection' ? 'Live' : l)}>{l} <b>{l === 'Applicable Rules' ? (sessionRules?.rules || []).filter((r: any) => r.status !== 'NOT_APPLICABLE').length : l === 'Documents' ? (documents?.total ?? evidence.length) : l === 'Previous Inspections' ? history.previous.length : ''}</b></button>)}
            {closed && <button type="button" className="ar-tab" role="tab" aria-selected={tab === 'Dossier'} onClick={() => setTab('Dossier')}>Dossier</button>}
          </div>
        </div>

        {tab === 'Applicable Rules' ? <div className="ar-scroll"><main className="ar-page" style={{ paddingTop: 20, gap: 20 }}>
          <section className="ar-funnel" aria-label="How rules were selected">
            {[{ n: sessionRules?.cascade?.library ?? '—', k: 'Rule library', sub: 'All indexed inspection rules', final: 'false' }, { n: sessionRules?.cascade?.valveType ?? '—', k: 'Match valve type', sub: sessionRules?.model ? `${sessionRules.model.family} · ${String(sessionRules.model.type).replace(/_/g, ' ')} · ${sessionRules.model.end_connection} ends` : current.model_id, final: 'false' }, { n: sessionRules?.cascade?.customerSpec ?? totalRules, k: 'Match customer specification', sub: sessionRules?.orderDocument ? `${sessionRules.orderDocument.orderNumber || sessionRules.orderDocument.name} · +${sessionRules.cascade.orderRules} order rules` : 'No specification uploaded · checkable from evidence', final: 'true' }].map((f: any) => <div key={f.k} className="ar-funnel-step" data-final={f.final}><span className="ar-funnel-n">{f.n}</span><span style={{ minWidth: 0 }}><span className="ar-h3" style={{ display: 'block' }}>{f.k}</span><span className="ar-micro" style={{ overflowWrap: 'anywhere' }}>{f.sub}</span></span></div>)}
          </section>
          <div className="ar-split" style={{ gap: 20 }}>
            <section className="ar-grow" aria-label="Applicable rules" style={{ flexBasis: 640 }}>
              {ruleSections.map((sec: any) => <div key={sec.name} className="ar-rsec">
                <div className="ar-rsec-head" style={{ position: 'static', paddingTop: 14 }}><h2 className="ar-h3" style={{ fontSize: 15 }}>{sec.name}</h2><span className="ar-micro">{sec.rows.length} {sec.rows.length === 1 ? 'rule' : 'rules'}</span></div>
                {sec.rows.map((r: any) => <article key={r.ruleId} className="ar-rule" data-open={openApp === r.ruleId}>
                  <button type="button" className="ar-rule-head with-result" aria-expanded={openApp === r.ruleId} onClick={() => setOpenApp(openApp === r.ruleId ? '' : r.ruleId)}>
                    <span className="ar-mono" style={{ color: 'var(--accent)', paddingTop: 1 }}>{ruleNo(r)}</span>
                    <span className="ar-h3">{r.title}</span>
                    <span className="ar-rule-line">{openApp === r.ruleId ? '' : r.quote}</span>
                    <span className="ar-micro">{evLabel(r)}</span>
                    <span><span className={badgeFor(r.status)}>{statusLabel(r.status)}</span></span>
                    <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true" style={{ color: '#8D93A8', marginTop: 2 }}><path d={openApp === r.ruleId ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
                  </button>
                  {openApp === r.ruleId && <div className="ar-rule-body" style={{ paddingLeft: 76 }}><div className="ar-rule-main">
                    <div className="ar-quote" style={{ fontSize: 14 }}>{r.quote}<small>Rule {ruleNo(r)} · {r.source}</small></div>
                    {r.finding?.reason && <div>{r.finding.reason}</div>}
                    <button type="button" className="ar-link" style={{ alignSelf: 'flex-start' }} onClick={() => setPage('rules')}>View rule {ruleNo(r)}<svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>
                  </div></div>}
                </article>)}
              </div>)}
              {!ruleSections.length && <div className="ar-empty"><strong>No applicable rules</strong><span>Rules for this inspection will appear here once the rule pack is pinned.</span></div>}
            </section>
            <aside className="ar-card pad ar-side" aria-label="Why these rules apply" style={{ display: 'flex', flexDirection: 'column', gap: 16, flexBasis: 320 }}>
              <h2 className="ar-h2">Why these rules</h2>
              <dl className="ar-facts" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <div><dt className="ar-micro">Valve type</dt><dd>{cadModels.find((m: any) => m.model_id === current.model_id)?.display_name || current.model_id}{sessionRules?.model ? ` · ${sessionRules.model.family} / ${String(sessionRules.model.type).replace(/_/g, ' ')}` : ''}</dd></div>
                <div><dt className="ar-micro">End connection</dt><dd>{sessionRules?.model?.end_connection ? `${titleCase(sessionRules.model.end_connection)}, from the CAD registry` : 'From the CAD registry'}</dd></div>
                <div><dt className="ar-micro">Customer specification or work order</dt><dd style={{ overflowWrap: 'anywhere' }}>{sessionRules?.orderDocument ? `${sessionRules.orderDocument.name}${sessionRules.orderDocument.orderNumber ? ` · ${sessionRules.orderDocument.orderNumber}` : ''} · ${sessionRules.orderDocument.extraction?.status === 'parsed' ? `${sessionRules.cascade.orderRules} order rules checkable` : 'rules could not be read'}` : 'None uploaded'}</dd></div>
                <div><dt className="ar-micro">Rule snapshot</dt><dd className="ar-mono" style={{ overflowWrap: 'anywhere' }}>{sessionRules?.snapshot ? `${sessionRules.snapshot.snapshotId} · library ${sessionRules.snapshot.libraryRevision}` : '—'}</dd></div>
              </dl>
              {current.lifecycleStatus === 'WAITING' && <>
                <label htmlFor="ins-spec" className="ar-drop"><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg><span><strong>Upload specification</strong><span className="ar-small">Adds the rules printed in the order; PDF, Word or Excel</span></span></label>
                <input id="ins-spec" className="ar-sr" type="file" accept=".pdf,.docx,.xlsx" onChange={e => { attachSpec(e.target.files?.[0]); e.target.value = ''; }} />
                {specNote && <span className="ar-small">{specNote}</span>}
              </>}
              {sessionRules?.why && <div className="ar-note">{sessionRules.why}</div>}
              <div>
                <div className="ar-label" style={{ marginBottom: 6 }}>Left out of this inspection</div>
                <ul style={{ display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--text-2)', fontSize: 13 }}>
                  <li>{leftOut.length} rules need measurement, functional-test or work-order records, not photographs or scans.</li>
                  <li>{sessionRules?.cascade?.filteredOut ?? 0} rules for other valve types or end connections: filtered by the pinned CAD model.</li>
                  {!sessionRules?.orderDocument && <li>Order rules: upload the customer specification or work order to add them.</li>}
                </ul>
              </div>
            </aside>
          </div>
        </main></div>
        : tab === 'Previous Inspections' && history?.previous?.length ? <div className="ar-scroll"><main className="ar-page" style={{ paddingTop: 20, gap: 20 }}>
          <div className="ar-note">Earlier inspections of work order <b>{history.orderNumber}</b>{history.assetId ? <> · asset <b>{history.assetId}</b></> : null}. Shown for reference only: they never change this inspection's results.</div>
          <section className="ar-card" aria-label="Earlier inspections of this order" style={{ overflow: 'hidden' }}>
            <div className="ar-rows"><div style={{ minWidth: 760 }}>
              <div className="ar-rowhead" style={{ gridTemplateColumns: '80px minmax(220px,2fr) 150px 112px 104px 90px' }}><span>Stage</span><span>Inspection</span><span>Started</span><span>Session</span><span>Outcome</span><span></span></div>
              {[...history.previous, { ...current, stageLabel: current.stageLabel, isCurrent: true }].map((p: any, k: number) => <div key={p.id} className="ar-row static" style={{ gridTemplateColumns: '80px minmax(220px,2fr) 150px 112px 104px 90px' }}>
                <span className="ar-mono ar-micro">Stage {k + 1}</span>
                <span style={{ minWidth: 0 }}><span className="ar-h3" style={{ display: 'block' }}>{p.name}{p.isCurrent ? ' (this inspection)' : ''}</span><span className="ar-micro">{p.stageLabel}</span></span>
                <span className="ar-small">{fmtDate(p.createdAt)}</span>
                <span><span className={statusClass(p.lifecycleStatus)}>{titleCase(p.lifecycleStatus)}</span></span>
                <span><span className={outcomeClass(p.outcome)}>{titleCase(p.outcome)}</span></span>
                <span>{!p.isCurrent && <button type="button" className="ar-btn ghost sm" onClick={async () => { const i = await api(`/api/v1/inspections/${p.id}`); if (i?.id) { setCurrent(i); setTab('Live'); } }}>Open</button>}</span>
              </div>)}
            </div></div>
          </section>
          <section className="ar-card" aria-label="Rule results across stages" style={{ overflow: 'hidden' }}>
            <div className="ar-bar" style={{ padding: '16px 20px 8px' }}><h2 className="ar-h3">Rule results across stages</h2><span className="ar-micro">Rules with a result in an earlier inspection</span></div>
            <div className="ar-rows"><div style={{ minWidth: 760 }}>
              <div className="ar-rowhead" style={{ gridTemplateColumns: `80px minmax(200px,1fr) repeat(${history.previous.length + 1}, 150px)` }}><span>Rule</span><span>Title</span>{history.previous.map((p: any, k: number) => <span key={p.id}>Stage {k + 1}</span>)}<span>Stage {history.previous.length + 1} (this)</span></div>
              {history.rules.map((r: any) => <div key={r.ruleId} className="ar-row static" style={{ gridTemplateColumns: `80px minmax(200px,1fr) repeat(${history.previous.length + 1}, 150px)`, alignItems: 'start' }}>
                <span className="ar-mono ar-micro" style={{ color: 'var(--accent)' }}>{r.code}</span>
                <span className="ar-small">{r.title}</span>
                {r.previous.map((p: any) => <span key={p.sessionId} title={p.reason || ''}><span className={p.status === 'NOT_IN_SCOPE' ? 'ar-badge' : badgeFor(p.status)}>{p.status === 'NOT_IN_SCOPE' ? 'Not in scope' : statusLabel(p.status)}</span></span>)}
                <span><span className={badgeFor(r.current)}>{statusLabel(r.current)}</span></span>
              </div>)}
              {!history.rules.length && <div className="ar-empty"><strong>No earlier results yet</strong><span>The earlier inspections have no evaluated rules.</span></div>}
            </div></div>
          </section>
        </main></div>
        : tab === 'Documents' ? <div className="ar-scroll"><main className="ar-page" style={{ paddingTop: 20 }}>
          <div className="ar-bar">
            <div className="ar-chips">
              {[['All', allDocs.length], ['Reports', allDocs.filter((d: any) => docCat(d) === 'Reports').length], ['Specifications', allDocs.filter((d: any) => docCat(d) === 'Specifications').length], ['Video', allDocs.filter((d: any) => docCat(d) === 'Video').length], ['Photographs', allDocs.filter((d: any) => docCat(d) === 'Photographs').length], ['Point clouds', allDocs.filter((d: any) => docCat(d) === 'Point clouds').length]].map(([l, n]: any) => <button key={l} type="button" className="ar-chip" aria-pressed={docFilter === l} onClick={() => setDocFilter(l)}>{l} <b>{n}</b></button>)}
            </div>
            <div className="ar-spacer"></div>
            <div className="ar-search" style={{ flex: '0 1 260px' }}>
              <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
              <label htmlFor="doc-search" className="ar-sr">Search documents</label>
              <input id="doc-search" className="ar-input" type="search" placeholder="Search files" value={docQ} onChange={e => setDocQ(e.target.value)} />
            </div>
          </div>
          <section className="ar-card" aria-label="Documents and evidence" style={{ overflow: 'hidden' }}>
            <div className="ar-rows"><div style={{ minWidth: 760 }}>
              <div className="ar-rowhead" style={{ gridTemplateColumns: '44px minmax(220px, 1fr) 130px 84px 112px 48px' }}><span></span><span>File</span><span>Type</span><span>Size</span><span>Received</span><span></span></div>
              {docRows.map((d: any, i: number) => <div key={d.evidenceId || d.name + i} className="ar-row static" style={{ gridTemplateColumns: '44px minmax(220px, 1fr) 130px 84px 112px 48px', minHeight: 58 }}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 38, overflow: 'hidden', background: 'var(--surface-2)', borderRadius: 8, color: 'var(--text-2)' }}>
                  {d.type === 'photo' ? <img src={`/api/v1/inspections/${current.id}/evidence/${d.evidenceId}/file`} alt="" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} /> : <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={d.type === 'cad' ? 'M12 2l9 5v10l-9 5-9-5V7ZM12 22V12M21 7l-9 5-9-5' : d.type === 'video' ? 'M4 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM17 10l5-3v10l-5-3' : 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5'} /></svg>}
                </span>
                <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontWeight: 600, overflowWrap: 'anywhere' }}>{d.name}</span><span className="ar-micro">{d.evidenceId ? `${d.source}${d.synthetic ? ' \u00B7 synthetic' : ''}` : d.source}</span></span>
                <span className="ar-small">{docKind(d)}</span>
                <span className="ar-mono ar-micro">{fmtSize(d.size)}</span>
                <span className="ar-mono ar-micro">{d.when}</span>
                {d.evidenceId || d.url ? <a className="ar-btn ghost sm icon-only" aria-label={`Download ${d.name}`} href={d.url || `/api/v1/inspections/${current.id}/evidence/${d.evidenceId}/file`} download={d.name}><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></svg></a> : d.type === 'Report' ? <button type="button" className="ar-btn ghost sm icon-only" aria-label={`Download ${d.name}`} onClick={downloadDossier}><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></svg></button> : <span></span>}
              </div>)}
            </div></div>
            {!docRows.length && <div className="ar-empty"><strong>{allDocs.length ? 'No files match' : 'No documents to display'}</strong><span>{allDocs.length ? 'Try another name or clear the filter.' : 'Evidence and reports for this inspection will appear here as they arrive.'}</span></div>}
          </section>
        </main></div>
        : tab === 'Dossier' ? (() => { const tone = ({ PASS: ['#0B6B4B', '#FFF'], WARNING: ['#FFB547', '#2A1B00'], FAIL: ['#8E2318', '#FFF'], INCONCLUSIVE: ['#2E3A73', '#FFF'], PENDING: ['#2E3A73', '#FFF'] } as any)[current.outcome] || ['#2E3A73', '#FFF']; const notInspected = (sessionRules?.rules || []).filter((r: any) => ['NOT_INSPECTED', 'NOT_APPLICABLE'].includes(r.status)).length; const insuff = (sessionRules?.rules || []).filter((r: any) => r.status === 'INSUFFICIENT_EVIDENCE').length; const regDocs = allDocs.filter((d: any) => d.type !== 'Report' && docCat(d) !== 'Specifications'); return <div className="ar-scroll"><main className="ar-page" style={{ paddingTop: 20, maxWidth: 1028 }}>
          <div className="ar-bar" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="ar-btn secondary" onClick={downloadDossier}><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></svg>Download PDF</button>
          </div>
          <article className="ar-paper">
            {current.lifecycleStatus === 'TERMINATED' && <div className="ar-paper-banner">Partial dossier. This inspection was terminated early, so evidence and checks are incomplete.</div>}
            <div className="ar-bar" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, paddingBottom: 24, borderBottom: '2px solid var(--paper-ink)' }}>
              <div style={{ flex: '1 1 380px', minWidth: 0 }}>
                <div className="ar-small" style={{ fontWeight: 600 }}>Argus inspection dossier</div>
                <h2 className="ar-h1" style={{ marginTop: 4 }}>{current.name}</h2>
                <p style={{ marginTop: 10, fontSize: 16 }}>{current.lifecycleStatus === 'TERMINATED' ? 'This inspection stopped before all checks ran. It cannot be read as a pass.' : findingCounts.fail ? `${findingCounts.fail} criterion failed. Review the detailed findings.` : findingCounts.warning ? `${findingCounts.pass} checks passed and ${findingCounts.warning} need review. No criterion failed.` : insuff || notInspected ? 'The inspection ended before all checks ran. The stream is recorded as truncated.' : 'All checks passed on the evidence received.'}</p>
              </div>
              <div style={{ flex: '0 1 230px', padding: '16px 18px', borderRadius: 8, background: tone[0], color: tone[1] }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Overall conclusion</div>
                <div style={{ fontSize: 28, lineHeight: 1.15, fontWeight: 700, letterSpacing: '-0.02em' }}>{(current.outcome || 'INCONCLUSIVE').toUpperCase()}</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(130px, 100%), 1fr))', gap: 8 }}>
              {[{ n: evaluated, k: 'Applicable rules evaluated', c: '#12141C' }, { n: findingCounts.pass, k: 'Pass', c: '#0B6B4B' }, { n: findingCounts.warning, k: 'Warning', c: '#7A4900' }, { n: findingCounts.fail, k: 'Fail', c: '#8E2318' }, { n: insuff + (sessionRules?.rules || []).filter((r: any) => r.status === 'NOT_INSPECTED').length, k: 'Insufficient or not inspected', c: '#4D5365' }].map((x: any) => <div key={x.k} className="ar-paper-tile"><div style={{ fontSize: 28, lineHeight: 1.1, fontWeight: 700, color: x.c }}>{x.n}</div><div className="ar-small">{x.k}</div></div>)}
            </div>
            <section><h3 className="ar-h2" style={{ marginBottom: 8 }}>Inspection identification</h3>
              {[{ k: 'Inspection ID', v: current.id }, { k: 'Lifecycle status', v: current.lifecycleStatus.toLowerCase() }, { k: 'Started', v: fmtDate(current.createdAt) }, { k: 'Closed', v: current.closedAt ? fmtDate(current.closedAt) : 'Finalizing' }, { k: 'Operator action', v: current.lifecycleStatus === 'TERMINATED' ? 'terminated' : 'normal_close' }].map((x: any) => <div key={x.k} className="ar-paper-row" style={{ gridTemplateColumns: '180px minmax(0, 1fr)' }}><span className="ar-muted">{x.k}</span><span>{x.v}</span></div>)}
            </section>
            <section><h3 className="ar-h2" style={{ marginBottom: 8 }}>Reference baseline</h3>
              {[{ k: 'CAD', v: `${cadFile} \u00B7 rev ${current.cadRevision} \u00B7 sha256 ${current.cadSha256?.slice(0, 16)}\u2026` }, { k: 'Applicable rules', v: `${totalRules} selected (library ${sessionRules?.cascade?.library ?? '—'} \u2192 valve type ${sessionRules?.cascade?.valveType ?? '—'}${sessionRules?.orderDocument ? ` \u2192 incl. ${sessionRules.cascade.orderRules} order rules` : ''}) \u00B7 snapshot ${sessionRules?.snapshot?.snapshotId || ''}` }, { k: 'Rule sources', v: [...new Set((sessionRules?.rules || []).map((r: any) => r.source))].join(', ') || 'Pinned rule pack' }].map((x: any) => <div key={x.k} className="ar-paper-row" style={{ gridTemplateColumns: '180px minmax(0, 1fr)' }}><span className="ar-muted">{x.k}</span><span>{x.v}</span></div>)}
            </section>
            <section><h3 className="ar-h2" style={{ marginBottom: 8 }}>Detailed findings</h3>
              {(sessionRules?.rules || []).map((r: any) => <div key={r.ruleId} className="ar-paper-row" style={{ gridTemplateColumns: '124px minmax(0, 1fr) 150px', alignItems: 'start' }}>
                <span style={{ fontWeight: 700, color: ({ PASS: '#0B6B4B', WARNING: '#7A4900', FAIL: '#8E2318', INSUFFICIENT_EVIDENCE: '#1F5C8A', NOT_INSPECTED: '#4D5365', NOT_APPLICABLE: '#4D5365', ANALYZING: '#1F5C8A' } as any)[r.status] || '#4D5365' }}>{statusLabel(r.status)}</span>
                <span><span style={{ display: 'block', fontWeight: 600 }}>{r.title}</span><span className="ar-muted" style={{ display: 'block' }}>{r.finding?.reason || 'Not evaluated.'}</span></span>
                <span className="ar-muted">Rule {ruleNo(r)}</span>
              </div>)}
            </section>
            <section><h3 className="ar-h2" style={{ marginBottom: 8 }}>Evidence register</h3>
              <p className="ar-small" style={{ marginBottom: 6 }}>{regDocs.length} files received. First six shown. All are listed under Documents.</p>
              {regDocs.slice(0, 6).map((d: any, i: number) => <div key={d.evidenceId || i} className="ar-paper-row" style={{ gridTemplateColumns: '86px 130px minmax(0, 1fr) 100px' }}><span className="ar-mono">{d.when}</span><span>{docKind(d)}</span><span style={{ overflowWrap: 'anywhere' }}>{d.name}</span><span className="ar-mono">{d.sha256 ? d.sha256.slice(0, 8) : '—'}</span></div>)}
            </section>
            <section><h3 className="ar-h2" style={{ marginBottom: 8 }}>Activity and caveats</h3>
              {[{ t: current.producerComplete ? 'Feeder completed. Producer-complete signal received.' : 'No producer-complete signal. Stream may be truncated.' }, { t: current.lifecycleStatus === 'TERMINATED' ? 'Terminate Now confirmed by the operator.' : 'End Inspection confirmed by the operator.' }, { t: 'Findings do not establish crack depth, leak tightness or bolt torque.' }, ...(allDocs.some((d: any) => d.synthetic) ? [{ t: 'All simulated evidence is marked synthetic.' }] : [])].map((n: any, i: number) => <div key={i} className="ar-paper-row">{n.t}</div>)}
            </section>
          </article>
        </main></div>; })()
        : <div className={`ar-live${closed ? ' closed' : ''}`}>
          {closed && <section aria-label="Inspection statistics" style={{ flex: '1 1 100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 10 }}>
            {[
              { n: evaluated, k: 'Total findings', c: 'var(--text)' },
              { n: findingCounts.pass, k: 'Pass', c: 'var(--pass)' },
              { n: (sessionRules?.rules || []).filter((r: any) => r.status === 'INSUFFICIENT_EVIDENCE').length, k: 'Evidence needed', c: 'var(--info)' },
              { n: findingCounts.fail, k: 'Critical', c: 'var(--fail)' },
              { n: geo?.coverage !== undefined ? `${Math.round(geo.coverage * 100)}%` : '\u2014', k: 'Laser point cloud coverage', c: 'var(--info)' },
              { n: evidence.length, k: 'Evidence files', c: 'var(--text)' }
            ].map((x: any) => <div key={x.k} className="ar-card" style={{ padding: '14px 16px' }}><div style={{ fontSize: 26, lineHeight: 1.1, fontWeight: 700, color: x.c }}>{x.n}</div><div className="ar-small">{x.k}</div>{x.k === 'Laser point cloud coverage' && geo && <div className="ar-micro">{geo.status === 'valid' ? 'CAD comparison succeeded' : geo.status}</div>}</div>)}
          </section>}
          <div className="ar-evidence" aria-label="Evidence">
            <div className="ar-bar" style={{ flex: 'none', justifyContent: 'space-between', gap: 8, minHeight: 30 }}>
              <h2 className="ar-h3">Evidence <span className="ar-micro" style={{ marginLeft: 4 }}>{evidence.length} {evidence.length === 1 ? 'file' : 'files'}</span></h2>
            </div>
            <div className="ar-evgrid">
              <section className="ar-media" aria-label="Video">
                <span className="ar-media-tag">Video</span><span className="ar-media-meta">{videos.length ? `${videos[videos.length - 1].sourceId}` : 'camera-01 idle'}</span>
                <button type="button" className="ar-btn secondary sm icon-only" aria-label="Open viewer" style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 3 }} onClick={() => setViewer({ kind: 'video' })}><ExpandIcon /></button>
                {videos.length ? <video key={videos[videos.length - 1].evidenceId} src={`/api/v1/inspections/${current.id}/evidence/${videos[videos.length - 1].evidenceId}/file`} controls muted playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} /> : <div className="ar-media-empty">{closed ? 'No video received' : 'Awaiting camera'}</div>}
              </section>
              <section className="ar-media" aria-label="3D point cloud" style={{ background: '#07080C' }}>
                <span className="ar-media-tag">Point cloud</span><span className="ar-media-meta">{pcs.length ? `${pcs.length} chunks` : 'laser-01 idle'}</span>
                <button type="button" className="ar-btn secondary sm icon-only" aria-label="Open 3D viewer" style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 3 }} onClick={() => setViewer({ kind: 'pointcloud' })}><ExpandIcon /></button>
                {pcs.length ? <><div style={{ position: 'absolute', inset: '44px 12px 12px', overflow: 'hidden', textAlign: 'center' }}><p className="ar-h3">{pcs.length} point-cloud chunks received</p><p className="ar-small">Chunk count is not surface coverage. Registration quality appears with findings.</p></div><Suspense fallback={null}><PointCloudThumb label="Latest laser scan" urls={pcs.map((e: any) => `/api/v1/inspections/${current.id}/evidence/${e.evidenceId}/file`)} /></Suspense><span className="ar-micro" style={{ position: 'absolute', left: 10, bottom: 10, zIndex: 3, background: '#0A0B10D9', padding: '2px 8px', borderRadius: 6 }}>Latest: {pcs[pcs.length - 1].filename} · {pcs.length} chunks merged</span>{geo && <span className="ar-micro" style={{ position: 'absolute', left: 10, bottom: 38, zIndex: 3, background: '#0A0B10D9', padding: '2px 8px', borderRadius: 6, color: geo.status === 'valid' ? 'var(--pass)' : geo.status === 'running' ? 'var(--accent)' : 'var(--warn)' }}>CAD comparison: {geoText}</span>}</> : <div className="ar-media-empty">{closed ? 'No scan received' : 'Awaiting laser scan'}</div>}
              </section>
              <section className="ar-media" aria-label="Photographs">
                <span className="ar-media-tag">Photographs</span><span className="ar-media-meta">{photos.length > PHOTO_SLOTS.length ? `${photos.length} received \u00B7 latest ${PHOTO_SLOTS.length}` : `${photos.length} of ${PHOTO_SLOTS.length}`}</span>
                <div className="ar-photos">
                  {PHOTO_SLOTS.map((label, i) => photos[i + photoOffset]
                    ? <button key={label} type="button" className="ar-photo" aria-label={`${photos[i + photoOffset].filename} photograph`} onClick={() => setViewer({ kind: 'photo', index: i + photoOffset })}><img src={`/api/v1/inspections/${current.id}/evidence/${photos[i + photoOffset].evidenceId}/file`} alt={photos[i + photoOffset].filename} /></button>
                    : <div key={label} className="ar-photo empty">{label}</div>)}
                </div>
              </section>
              <section className="ar-media" aria-label="CAD reference" style={{ background: '#07080C' }}>
                <span className="ar-media-tag">CAD reference</span><span className="ar-media-meta">{cadFile}</span>
                <div className="ar-stagebox"><div className="ar-4x3"><img src="/assets/27eb1fb0b3044c82e23e2ffd10ff5ad6.svg" alt="Wireframe reference model of the valve" /></div></div><Suspense fallback={null}><PointCloudThumb label="CAD reference point cloud" color="#9db4d0" urls={[`/api/v1/cad-models/${current.model_id}/reference.ply?sample=80000`]} /></Suspense><button type="button" className="ar-btn secondary sm icon-only" aria-label="Open CAD viewer" style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 3 }} onClick={() => setViewer({ kind: 'cad' })}><ExpandIcon /></button>
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

          <aside className="ar-panel" aria-label="Inspection stage and findings" style={closed ? undefined : { flexBasis: 'clamp(420px, 36%, 620px)' }}>
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
              {!!pcs.length && <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div className="ar-bar" style={{ justifyContent: 'space-between' }}>
                  <span className="ar-label">CAD comparison</span>
                  {geo?.status !== 'running' && !closed && <button type="button" className="ar-btn ghost sm" onClick={async () => { await api(`/api/v1/inspections/${current.id}/compare`, { method: 'POST' }); setCurrent({ ...current, geometry: { status: 'running' } }); }}>{geo ? 'Re-run' : 'Compare with CAD'}</button>}
                </div>
                {geo ? <>
                  <span><span className={geo.status === 'valid' ? 'ar-badge pass' : geo.status === 'running' ? 'ar-badge accent' : 'ar-badge warn'}>{geo.status === 'running' ? 'Running' : titleCase(geo.status)}</span></span>
                  <span className="ar-micro">{geoText}</span>
                  {geo.scanPoints && <span className="ar-micro">{geo.scanPoints.toLocaleString()} scan points · {geo.chunks} chunks · merged scan</span>}
                </> : <span className="ar-micro">Not run yet. Runs automatically as scan chunks arrive.</span>}
              </div>}
              {closed && <div className="ar-bar" style={{ justifyContent: 'space-between' }}>
                <span className={outcomeClass(current.outcome)}>Outcome: {titleCase(current.outcome)}</span>
                <button type="button" className="ar-btn secondary sm" onClick={() => setTab('Dossier')}>Open Dossier</button>
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
                {analyzingNow.map((e: any) => <article key={`an-${e.evidenceId}`} className="ar-finding feed-analyzing" data-open="false">
                  <div className="ar-finding-head" style={{ cursor: 'default' }}>
                    <span style={{ minWidth: 0 }}>
                      <span className="ar-finding-meta" style={{ justifyContent: 'flex-start' }}><span className="ar-badge info"><span className="feed-pulse">Analyzing…</span></span><span className="ar-mono ar-micro">{e.mediaType === 'video' ? 'Video segment' : 'Photograph'}</span></span>
                      <span className="ar-finding-title">{e.filename}</span>
                      <span className="ar-finding-cap">SAM 3.1 is finding the valve parts in view; Muse is checking them against the rules.</span>
                    </span>
                  </div>
                </article>)}
                {liveRules.slice(0, 40).map((r: any) => <article key={feedKey(r)} className={`ar-finding${seen.current.fresh.has(feedKey(r)) ? ' feed-flash' : ''}`} data-open="false">
                  <div className="ar-finding-head" style={{ cursor: 'default' }}>
                    <span style={{ minWidth: 0 }}>
                      <span className="ar-finding-meta" style={{ justifyContent: 'flex-start' }}><span className={badgeFor(r.status)}>{titleCase(r.status)}</span><span className="ar-mono ar-micro">Rule {ruleNo(r)}</span><span className="ar-mono ar-micro" style={{ marginLeft: 'auto' }}>{sinceStart(r.finding?.at)}</span></span>
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
            {[...(sessionRules?.rules || [])].sort((a: any, b: any) => ({ FAIL: 0, WARNING: 1, INSUFFICIENT_EVIDENCE: 2, PASS: 3, NOT_INSPECTED: 4, NOT_APPLICABLE: 5, ANALYZING: 2 } as any)[a.status] - ({ FAIL: 0, WARNING: 1, INSUFFICIENT_EVIDENCE: 2, PASS: 3, NOT_INSPECTED: 4, NOT_APPLICABLE: 5, ANALYZING: 2 } as any)[b.status]).map((r: any) => {
              const isOpen = openRead[r.ruleId] !== undefined ? openRead[r.ruleId] : ['FAIL', 'WARNING', 'INSUFFICIENT_EVIDENCE'].includes(r.status);
              const evs = (r.finding?.evidenceIds || []).map((id: string) => evidence.find((e: any) => e.evidenceId === id)).filter(Boolean);
              const evPhoto = evs.find((e: any) => e.mediaType === 'photo');
              const evPc = evs.find((e: any) => e.mediaType === 'pointcloud');
              const rel = r.finding?.at ? (() => { const s = Math.max(0, Math.round((new Date(r.finding.at).getTime() - new Date(current.createdAt).getTime()) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; })() : '';
              return <article key={r.ruleId} className="ar-read">
              <button type="button" className="ar-read-head" aria-expanded={isOpen} onClick={() => setOpenRead({ ...openRead, [r.ruleId]: !isOpen })}>
                <span><span className={badgeFor(r.status)}>{titleCase(r.status)}</span></span>
                <span style={{ minWidth: 0 }}><span className="ar-read-title">{r.title}</span><span className="ar-read-cap">{r.finding?.reason || 'Not evaluated.'}</span></span>
                <span className="ar-mono ar-micro" style={{ paddingTop: 3 }}>Rule {ruleNo(r)}</span>
                <span className="ar-mono ar-micro" style={{ paddingTop: 3 }}>{rel}</span>
                <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true" style={{ color: '#8D93A8', marginTop: 3 }}><path d={isOpen ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
              </button>
              {isOpen && <div className="ar-read-body">
                {evPhoto && <div className="ar-read-img"><img src={`/api/v1/inspections/${current.id}/evidence/${evPhoto.evidenceId}/file`} alt={evPhoto.filename} style={{ display: 'block', width: '100%', borderRadius: 8 }} /></div>}
                {!evPhoto && evPc && <div className="ar-read-img" style={{ position: 'relative', height: 150 }}><Suspense fallback={null}><PointCloudThumb label={`Scan for ${r.title}`} urls={[`/api/v1/inspections/${current.id}/evidence/${evPc.evidenceId}/file`]} /></Suspense></div>}
                <div className="ar-read-text" style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="ar-quote" style={{ fontSize: 14 }}>{r.quote}<small>Rule {ruleNo(r)} · {r.source}</small></div>
                  <div>{r.finding?.reason || 'Not evaluated.'}</div>
                  <div className="ar-mono ar-micro">{evs.length ? evs.map((e: any) => e.filename).join(' · ') : 'No evidence evaluated'}</div>
                  <button type="button" className="ar-link" style={{ alignSelf: 'flex-start' }} onClick={() => setPage('rules')}>View rule {ruleNo(r)}<svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>
                </div>
              </div>}
            </article>; })}
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
              {homeGroups.map(g => <div key={g.key}>
                {g.items.length > 1 && <div className="ar-row static" style={{ gridTemplateColumns: '1fr', minHeight: 40, background: 'var(--surface-2)' }}><span className="ar-micro">Work order <b className="ar-mono">{g.key}</b> · {g.items.length} inspections of the same equipment, in stage order</span></div>}
                {g.items.map((i: any, k: number) => {
                const f = i.findings || { pass: 0, warning: 0, fail: 0, insufficient: 0, unchecked: 0, total: 0 };
                const seg = [[f.pass, '#4BE0A0'], [f.warning, '#FFC554'], [f.fail, '#FF7468'], [f.insufficient, '#7AB8FF'], [f.unchecked, '#3A4152']].filter(([n]: any) => n > 0);
                return <button key={i.id} type="button" className="ar-row" style={{ gridTemplateColumns: 'minmax(200px,2fr) 150px 112px 104px minmax(150px,1.3fr) 16px', paddingLeft: g.items.length > 1 ? 36 : undefined }} onClick={() => { setCurrent(i); setPage('session'); }}>
                  <span style={{ minWidth: 0 }}><span className="ar-h3" style={{ display: 'block' }}>{i.name}</span><span className="ar-mono ar-micro">{g.items.length > 1 ? `Stage ${k + 1} · ` : ''}{i.id}{g.items.length === 1 && i.groupKey ? ` · ${i.groupKey}` : ''}</span></span>
                  <span className="ar-small">{fmtDate(i.createdAt)}</span>
                  <span><span className={statusClass(i.lifecycleStatus)}>{titleCase(i.lifecycleStatus)}</span></span>
                  <span><span className={outcomeClass(i.outcome)}>{titleCase(i.outcome)}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{f.total ? <><span className="ar-minibar">{seg.map(([n, c]: any, k: number) => <span key={k} style={{ flex: `${n} 1 0`, background: c }} />)}</span><span className="ar-micro">{[f.pass && `${f.pass} Pass`, f.warning && `${f.warning} Warning`, f.fail && `${f.fail} Fail`, f.insufficient && `${f.insufficient} Insufficient`, f.unchecked && `${f.unchecked} Unchecked`].filter(Boolean).join(' · ')}</span></> : <span className="ar-micro">No findings yet</span>}</span>
                  <svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true" style={{ color: '#8D93A8' }}><path d="m9 5 7 7-7 7V5Z" /></svg>
                </button>;
              })}</div>)}
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
              {specFile
                ? <div className="ar-bar" style={{ justifyContent: 'space-between' }}><span className="ar-small" style={{ overflowWrap: 'anywhere' }}>{specFile.name} · {Math.max(1, Math.round(specFile.size / 1024))} KB</span><button type="button" className="ar-btn ghost sm icon-only" aria-label="Remove specification" onClick={() => setSpecFile(null)}><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div>
                : <label htmlFor="spec-file" className="ar-drop"><svg className="ar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3h2v10.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2V3ZM5 20h14v2H5Z" /></svg><span><strong>Upload specification</strong><span className="ar-small">PDF, Word or Excel</span></span></label>}
              <input id="spec-file" className="ar-sr" type="file" accept=".pdf,.docx,.xlsx" onChange={e => { setSpecFile(e.target.files?.[0] || null); e.target.value = ''; }} /></div>
            <dl className="ar-dl"><dt>Valve type</dt><dd>{(() => { const m = cadModels.find(x => x.model_id === modelId); return m ? `${m.display_name}${m.type ? ` · ${String(m.type).replace(/_/g, ' ')}` : ''}` : 'CVS 6000D'; })()}</dd><dt>Rules</dt><dd>{specFile ? 'Selected from the valve type, plus the rules printed in this document' : 'Selected from the valve type; add a document for order rules'}</dd></dl>
            {formNote && <div className="ar-note">{formNote}</div>}
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
                <button type="button" className="ar-btn secondary sm" onClick={async () => { const i = await api(`/api/v1/inspections/${r.sessionId}`); if (i?.id) { setCurrent(i); setTab('Dossier'); setPage('session'); } }}>View</button>
                <button type="button" className="ar-btn ghost sm" onClick={() => pdfDownload(r.sessionId)}>Download PDF</button>
              </span></div>)}
          </div></div>
          {!filteredReports.length && (reports.length ? <div className="ar-empty"><strong>No reports match</strong><span>Try another name or clear the filter.</span></div> : <div className="ar-empty"><strong>No reports to display</strong><span>Complete an inspection and its dossier will appear here. Create one from Home to get started.</span></div>)}
        </section></>}

      </main></div>)}
      {viewer && current && <Suspense fallback={null}><ViewerDialog viewer={viewer} sessionId={current.id} photos={photos} videos={videos} pcs={pcs} cadUrl={`/api/v1/cad-models/${current.model_id}/reference.ply?sample=200000`} onClose={() => setViewer(null)} onPhoto={(index) => setViewer({ kind: 'photo', index })} onShowFindings={() => { setViewer(null); setTab('Applicable Rules'); }} /></Suspense>}
    </div>
  );
}
