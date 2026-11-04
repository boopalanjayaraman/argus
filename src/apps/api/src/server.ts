import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { storageMode, putObjectIfConfigured } from './storage.js';
import { mongoStore, mergeStates } from './db.js';
import { logger } from './logger.js';
import { loadRuleIndex, selectSessionRules, evaluable } from './rules.js';
import { AnalysisQueue, type Job } from './analysis.js';

// Minimal .env loader (no dependency): repo-root .env, process env wins.
// Skipped under tests so suites stay hermetic (no real Atlas/GCS calls).
if (!process.env.VITEST) try {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DATA = process.env.ARGUS_DATA_DIR || path.join(root, 'data');
// Working copy of the store. On Cloud Run DATA can be a Cloud Storage FUSE
// mount (evidence, documents, dossiers) while this file stays on local disk;
// MongoDB is the source of truth at startup when configured.
const DB_FILE = process.env.ARGUS_DB_FILE || path.join(DATA, 'db.json');
const PORT = Number(process.env.PORT || 8000);
fs.mkdirSync(path.join(DATA, 'evidence'), { recursive: true });

const cadModels = JSON.parse(fs.readFileSync(path.join(root, 'src/cad_models.json'), 'utf8')).cad_models;
const ORDER_EXTENSIONS = ['.pdf', '.docx', '.xlsx'];
const CLOSED = ['COMPLETED', 'TERMINATED'];
/** Job kinds that never hold a session in ANALYZING or delay closure. */
const DISPLAY_ONLY: ('tracking')[] = ['tracking'];
const DECIDED = ['PASS', 'WARNING', 'FAIL'];

/** Stride-sample a binary PLY to at most `max` vertices (header rewritten). */
export function samplePlyBuffer(data: Buffer, max: number): Buffer {
  const headerEnd = data.indexOf('end_header\n');
  if (headerEnd < 0) return data;
  const head = data.subarray(0, headerEnd).toString('ascii');
  const countMatch = head.match(/element vertex (\d+)/);
  if (!countMatch) return data;
  const total = Number(countMatch[1]);
  const sizes: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  let stride = 0; let inVertex = false;
  for (const line of head.split('\n')) {
    if (line.startsWith('element ')) { inVertex = line.split(/\s+/)[1] === 'vertex'; continue; }
    if (inVertex && line.startsWith('property ')) stride += sizes[line.split(/\s+/)[1]] || 0;
  }
  if (!stride || total <= max) return data;
  const bodyStart = headerEnd + 'end_header\n'.length;
  const step = Math.ceil(total / max);
  const kept = Math.ceil(total / step);
  const header = head.replace(/element vertex \d+/, `element vertex ${kept}`) + 'end_header\n';
  const parts: Buffer[] = [Buffer.from(header, 'ascii')];
  for (let i = 0; i < total; i += step) parts.push(data.subarray(bodyStart + i * stride, bodyStart + (i + 1) * stride));
  return Buffer.concat(parts);
}

/** Locate the generated CAD reference cloud for a model (matched by CAD sha). */
export function cadReferencePath(model: any): string | null {
  const base = path.join(root, 'src/reference-data');
  try {
    for (const dir of fs.readdirSync(base)) {
      const metaFile = path.join(base, dir, 'cad', 'cad_reference.json');
      const plyFile = path.join(base, dir, 'cad', 'cad_reference.ply');
      if (!fs.existsSync(metaFile) || !fs.existsSync(plyFile)) continue;
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta.sourceCadSha256 === model.sha256) return plyFile;
    }
  } catch {}
  return null;
}

interface DB { inspections: any[]; evidence: any[]; findings: any[]; events: any[]; dossiers: any[]; referenceSnapshots: any[]; documents: any[]; observations: any[] }
const emptyDB = (): DB => ({ inspections: [], evidence: [], findings: [], events: [], dossiers: [], referenceSnapshots: [], documents: [], observations: [] });
function loadDB(): DB { try { return { ...emptyDB(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { return emptyDB(); } }
let mongoSyncTimer: any = null;
function saveDB(db: DB) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  if (mongoStore.connected) {
    clearTimeout(mongoSyncTimer);
    mongoSyncTimer = setTimeout(() => { mongoStore.syncState(db as any).catch(() => {}); }, 200);
  }
}
let db = loadDB();
const listeners = new Map<string, Set<any>>();
const eventSeqs = new Map<string, number>();
function emit(db: DB, sessionId: string, type: string, payload: any = {}) {
  if (!eventSeqs.has(sessionId)) eventSeqs.set(sessionId, db.events.filter(e => e.sessionId === sessionId).reduce((m, e) => Math.max(m, e.eventSeq || 0), 0));
  const eventSeq = eventSeqs.get(sessionId)! + 1;
  eventSeqs.set(sessionId, eventSeq);
  const ev = { eventSeq, sessionId, type, at: new Date().toISOString(), ...payload };
  db.events.push(ev); saveDB(db);
  (listeners.get(sessionId) || new Set()).forEach((res: any) => { try { res.write(`id: ${ev.eventSeq}\ndata: ${JSON.stringify(ev)}\n\n`); } catch {} });
  return ev;
}

/** Ingest-token gate (spec §10.4): when ARGUS_INGEST_TOKEN is configured
 * (non-placeholder), evidence-ingestion POSTs must carry a matching
 * `Authorization: Bearer <token>`. Unset/placeholder = local demo, no gate.
 * Read at request time so tests and rotation don't need a restart. */
export function ingestAuthorized(req: any): boolean {
  const token = process.env.ARGUS_INGEST_TOKEN || '';
  if (!token || token.includes('<')) return true;
  const header = String(req.headers?.authorization || '');
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented) return false;
  const a = Buffer.from(presented), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function aggregateOutcome(statuses: string[], terminated = false): string {
  if (statuses.includes('FAIL')) return 'FAIL';
  const app = statuses.filter(s => s !== 'NOT_APPLICABLE');
  if (terminated) return 'INCONCLUSIVE';
  if (!app.length) return 'PENDING';
  if (app.some(s => ['NOT_INSPECTED', 'INSUFFICIENT_EVIDENCE', 'ANALYZING'].includes(s))) return 'INCONCLUSIVE';
  if (app.includes('WARNING')) return 'WARNING';
  return 'PASS';
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
/** Dossier file on disk; older records stored paths relative to the repo root. */
const dossierFile = (d: any) => String(d.htmlPath).startsWith('data/') ? path.join(root, d.htmlPath) : path.join(DATA, d.htmlPath);
const modelFor = (id: string) => cadModels.find((m: any) => m.model_id === id);

/** Pin the session's rule set (Spec §5, PRD-06): every later analysis,
 * citation and dossier reads this snapshot, never the live library. */
export function pinSnapshot(insp: any, orderDocument: any | null, legacy = false) {
  const model = modelFor(insp.model_id) || {};
  const index = loadRuleIndex();
  const sel = selectSessionRules(index, model, orderDocument);
  const revision = db.referenceSnapshots.filter(s => s.sessionId === insp.id).length + 1;
  const snapshot = {
    snapshotId: `ref-${insp.id}-r${revision}`, sessionId: insp.id, revision, createdAt: new Date().toISOString(), legacy,
    library: { packId: index.packId, revision: index.revision },
    model: { model_id: model.model_id, display_name: model.display_name, family: model.family, type: model.type, end_connection: model.end_connection, cadRevision: insp.cadRevision, cadSha256: insp.cadSha256 },
    orderDocument: orderDocument ? { documentId: orderDocument.documentId, name: orderDocument.name, sha256: orderDocument.sha256, orderNumber: orderDocument.orderNumber || null, ruleCount: (orderDocument.rules || []).length } : null,
    cascade: sel.cascade, rules: sel.rules, sha256: sha256(JSON.stringify(sel.rules)),
  };
  db.referenceSnapshots.push(snapshot);
  insp.referenceSnapshotId = snapshot.snapshotId;
  return snapshot;
}

/** The session's current pinned snapshot. Sessions created before pinning
 * existed get one built on first access and marked legacy. */
export function snapshotFor(insp: any) {
  const snaps = db.referenceSnapshots.filter(s => s.sessionId === insp.id);
  if (snaps.length) return snaps.sort((a, b) => b.revision - a.revision)[0];
  const snap = pinSnapshot(insp, null, true); saveDB(db); return snap;
}

/** Latest finding per rule for one session (revisions supersede). */
export function latestFindings(findings: any[], sessionId: string): any[] {
  const latest = new Map<string, any>();
  for (const f of findings) {
    if (f.sessionId !== sessionId) continue;
    const prev = latest.get(f.ruleId);
    if (!prev || f.revision > prev.revision) latest.set(f.ruleId, f);
  }
  return [...latest.values()];
}

/** Latest finding status per rule for one session (revisions supersede). */
export function latestStatuses(findings: any[], sessionId: string): string[] {
  return latestFindings(findings, sessionId).map((f: any) => f.ruleStatus);
}

function sessionRules(insp: any) {
  const latest = new Map(latestFindings(db.findings, insp.id).map(f => [f.ruleId, f]));
  return snapshotFor(insp).rules.map((r: any) => {
    const f = latest.get(r.ruleId);
    return { ...r, status: !evaluable(r) ? 'NOT_APPLICABLE' : f ? f.ruleStatus : 'NOT_INSPECTED', finding: f || null };
  });
}

/** Map an orchestrator observation to a finding verdict, or null to keep
 * the existing state (unavailable / not inspected never overwrites). */
export function verdictFromObservation(obs: any): { ruleId: string; status: string; reason: string; evidenceId: string | null } | null {
  if (!obs?.ruleId || !obs?.ruleStatus) return null;
  if (['NOT_INSPECTED', 'NOT_APPLICABLE', 'ANALYZING'].includes(obs.ruleStatus)) return null;
  if (obs.status === 'unavailable' || obs.kind === 'failed') return null;
  if (obs.kind === 'evidence_needed') return { ruleId: obs.ruleId, status: 'INSUFFICIENT_EVIDENCE', reason: obs.notes || 'Needs evidence beyond this image', evidenceId: obs.evidenceId || null };
  const parts = [obs.notes || `${obs.kind || 'observation'} (${obs.certainty || 'unknown'})`];
  if (obs.model) parts.push(`screened by ${obs.model}`);
  if (obs.review?.notes) parts.push(`review: ${obs.review.notes}`);
  return { ruleId: obs.ruleId, status: obs.ruleStatus, reason: parts.join(' · '), evidenceId: obs.evidenceId || null };
}

/** Best (highest-fitness) geometry registration from orchestrator observations. */
export function pickRegistration(observations: any[]): any | null {
  const regs = (observations || []).filter((o: any) => o?.registration).map((o: any) => ({ ...o.registration, evidenceEventId: o.evidence?.eventId || o.eventId || null }));
  if (!regs.length) return null;
  return regs.sort((a: any, b: any) => (b.fitness || 0) - (a.fitness || 0))[0];
}

/** Human-readable reason for a scan rule decided from a registration. */
export function geometryReason(rule: any, status: string, reg: any): string {
  const conds = [...(rule.prerequisites || []), ...(Array.isArray(rule.threshold) ? rule.threshold : rule.threshold ? [rule.threshold] : [])];
  const fmt = (c: any) => {
    const v = reg?.[c.metric];
    const shown = v === undefined || v === null ? 'n/a' : c.metric === 'surfaceCoverageFraction' || c.metric === 'fitness' ? `${(v * (c.metric === 'fitness' ? 1 : 100)).toFixed(c.metric === 'fitness' ? 3 : 1)}${c.metric === 'fitness' ? '' : '%'}` : `${Number(v).toFixed(2)} mm`;
    const limit = c.metric === 'surfaceCoverageFraction' ? `${Math.round((c.min ?? c.max) * 100)}%` : c.unit === 'mm' ? `${c.max ?? c.min} mm` : `${c.min ?? c.max}`;
    return `${c.metric} ${shown} (${'max' in c ? '≤' : '≥'} ${limit})`;
  };
  return `${status === 'PASS' ? 'Within' : status === 'FAIL' ? 'Outside' : 'Not decidable:'} approved scan limits · ${conds.map(fmt).join(' · ')} · merged scan of ${reg?.mergedChunks ?? '?'} chunks vs CAD`;
}

/** Asset identifier printed in an order document (assembly ID, serial or
 * tag number), read from the extracted order text. */
export function assetIdFrom(text: string): string | null {
  const m = String(text || '').match(/(?:assembly identifier|assembly id|serial (?:no\.?|number)|tag (?:no\.?|number)|asset (?:id|number))\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]{3,})/i);
  return m ? m[1].replace(/[.]+$/, '') : null;
}

/** Inspections of the same equipment: same order number and, when the
 * order prints one, the same assembly/serial ID. No order -> no group. */
export function groupKeyOf(orderNumber: string | null, assetId: string | null): string | null {
  return orderNumber ? `${orderNumber}${assetId ? ` / ${assetId}` : ''}` : null;
}

/** Short, lightly worded label for a finding drawn on the analyzed video:
 * the model's own observation, trimmed, never a verdict. */
export function annotationText(status: string, reason: string): string {
  const note = String(reason || '').split(' · ')[0].replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  const short = note.length <= 64 ? note : note.slice(0, 64).replace(/\s+\S*$/, '') + '…';
  const lead = short && /^[A-Z][a-z]/.test(short) ? short.charAt(0).toLowerCase() + short.slice(1) : short; // keep acronyms (ID, RF, MTC)
  return `${status === 'FAIL' ? 'Possible issue' : 'Worth a look'}: ${lead || 'see findings'}`;
}

/** Attach FAIL / WARNING findings to tracked components (display only). */
export function videoLabels(rules: any[], tracks: any): any[] {
  const tracked = new Set((tracks?.components || []).filter((c: any) => (c.objects || []).length).map((c: any) => c.id));
  const byComponent: Record<string, string[]> = tracks?.componentRules || {};
  const out: any[] = [];
  for (const r of rules) {
    if (!['FAIL', 'WARNING'].includes(r.status) || !r.finding) continue;
    for (const [componentId, codes] of Object.entries(byComponent)) {
      if (!tracked.has(componentId) || !(codes as string[]).includes(r.ruleId)) continue;
      out.push({ componentId, ruleId: r.ruleId, rule: r.code || r.ruleId, title: r.title, status: r.status, text: annotationText(r.status, r.finding.reason) });
    }
  }
  return out;
}

/** Stream order for video segments: sequence, then capture time. */
export function orderVideos(evidences: any[]): any[] {
  return evidences.filter((e: any) => e.mediaType === 'video')
    .sort((a: any, b: any) => (a.sequence || 0) - (b.sequence || 0) || (a.relativeTimeMs || 0) - (b.relativeTimeMs || 0) || String(a.eventId).localeCompare(String(b.eventId)));
}

/** Parse a single Range header; returns null when absent/invalid. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  return { start, end };
}

const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
/** Citation for a pinned rule: document + section (+ page for order rules). */
export function citation(r: any): string {
  const doc = r.document && !String(r.source || '').includes(r.document) ? `${r.source || ''} (${r.document})` : r.source || '';
  const where = r.origin === 'order' ? (r.page ? `p.${r.page}` : '') : r.section && r.section !== r.ruleId ? `§ ${r.section}` : '';
  return [doc, where, `rule ${r.code || r.ruleId}`].filter(Boolean).join(' · ');
}

/** The frozen dossier as structured data — what the ReportAgent lays out
 * as PDF. Same facts as the HTML dossier. */
function dossierData(insp: any, partial: boolean) {
  const snap = snapshotFor(insp);
  const rules = sessionRules(insp);
  const evidence = db.evidence.filter(e => e.sessionId === insp.id);
  const evName = new Map(evidence.map(e => [e.evidenceId, e.filename]));
  const applicable = rules.filter((r: any) => r.status !== 'NOT_APPLICABLE');
  const count = (st: string) => applicable.filter((r: any) => r.status === st).length;
  const order = snap.orderDocument;
  return {
    inspection: { id: insp.id, name: insp.name, outcome: insp.outcome, lifecycleStatus: insp.lifecycleStatus, partial, createdAt: insp.createdAt, closedAt: insp.closedAt },
    baseline: { cadName: snap.model.display_name, modelId: insp.model_id, cadRevision: insp.cadRevision, cadSha256: insp.cadSha256, family: snap.model.family, type: snap.model.type, endConnection: snap.model.end_connection,
      snapshotId: snap.snapshotId, snapshotSha256: snap.sha256, libraryRevision: snap.library.revision, cascade: snap.cascade, order: order ? { orderNumber: order.orderNumber, name: order.name, sha256: order.sha256 } : null },
    summary: { applicable: applicable.length, pass: count('PASS'), warning: count('WARNING'), fail: count('FAIL'), insufficient: count('INSUFFICIENT_EVIDENCE'), notInspected: count('NOT_INSPECTED') },
    geometry: insp.geometry || null,
    findings: applicable.map((r: any) => ({ ruleId: r.code || r.ruleId, title: r.title, status: r.status, quote: r.quote, citation: citation(r), reason: r.finding?.reason || 'Not evaluated.', evidence: (r.finding?.evidenceIds || []).map((id: string) => evName.get(id) || id) })),
    notEvaluated: rules.filter((r: any) => r.status === 'NOT_APPLICABLE').map((r: any) => ({ ruleId: r.code || r.ruleId, title: r.title, citation: citation(r) })),
    incomplete: insp.incompleteAnalysis || [],
    evidence: evidence.map(e => ({ mediaType: e.mediaType, filename: e.filename, sourceId: e.sourceId, size: e.size, sha256: e.sha256, processingStatus: e.processingStatus })),
    generatedAt: new Date().toISOString(),
    disclaimer: 'Findings are observations checked against the rules pinned for this inspection. They do not establish crack depth, leak tightness or bolt torque. This dossier is not a certification or a release; a quality engineer must review and sign it.',
  };
}

function dossierHtml(insp: any, partial: boolean) {
  const snap = snapshotFor(insp);
  const rules = sessionRules(insp);
  const evidence = db.evidence.filter(e => e.sessionId === insp.id);
  const evName = new Map(evidence.map(e => [e.evidenceId, e.filename]));
  const applicable = rules.filter((r: any) => r.status !== 'NOT_APPLICABLE');
  const count = (s: string) => applicable.filter((r: any) => r.status === s).length;
  const geo = insp.geometry || null;
  const rows = applicable.map((r: any) => `<tr><td>${esc(r.ruleId)}</td><td>${esc(r.title)}</td><td>${esc(r.status)}</td><td>${esc(r.quote)}<br><small>${esc(citation(r))}</small></td><td>${esc(r.finding?.reason || 'Not evaluated.')}<br><small>${esc((r.finding?.evidenceIds || []).map((id: string) => evName.get(id) || id).join(', '))}</small></td></tr>`).join('');
  const reference = rules.filter((r: any) => r.status === 'NOT_APPLICABLE').map((r: any) => `<li>${esc(r.ruleId)} ${esc(r.title)} <small>${esc(citation(r))}</small></li>`).join('');
  const incomplete = (insp.incompleteAnalysis || []).map((j: any) => `<li>${esc(j.kind)} ${esc(j.evidenceId || '')}: ${esc(j.reason)}</li>`).join('');
  const register = evidence.map(e => `<tr><td>${esc(e.mediaType)}</td><td>${esc(e.filename)}</td><td>${esc(e.sourceId)}</td><td>${e.size}</td><td><code>${esc(e.sha256)}</code></td><td>${esc(e.processingStatus)}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Dossier ${esc(insp.id)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:32px;color:#12141c}table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border:1px solid #ccd;padding:6px;vertical-align:top;text-align:left}small{color:#4d5365}code{font-size:11px}</style>
<h1>${esc(insp.name)}</h1>
<p><b>Overall conclusion: ${esc(insp.outcome)}</b> · ${partial ? 'Partial dossier (terminated)' : 'Full dossier'} · Lifecycle ${esc(insp.lifecycleStatus)} · ${esc(insp.id)}</p>
<p>Started ${esc(insp.createdAt)} · Closed ${esc(insp.closedAt)}</p>
<h2>Reference baseline</h2>
<p>CAD ${esc(snap.model.display_name)} (${esc(insp.model_id)}) rev ${esc(insp.cadRevision)} · sha256 <code>${esc(insp.cadSha256)}</code><br>
Equipment ${esc(snap.model.family)} / ${esc(snap.model.type)} / ${esc(snap.model.end_connection)} ends<br>
Rule snapshot ${esc(snap.snapshotId)} · sha256 <code>${esc(snap.sha256)}</code> · library revision ${esc(snap.library.revision)}<br>
Rule selection: library ${snap.cascade.library} → valve type ${snap.cascade.valveType} → selected ${snap.cascade.customerSpec}${snap.orderDocument ? ` (incl. ${snap.cascade.orderRules} order rules)` : ''}<br>
Customer order: ${snap.orderDocument ? `${esc(snap.orderDocument.orderNumber || '')} ${esc(snap.orderDocument.name)} · sha256 <code>${esc(snap.orderDocument.sha256)}</code>` : 'none uploaded'}</p>
<h2>Summary</h2>
<p>${applicable.length} applicable rules: ${count('PASS')} pass · ${count('WARNING')} warning · ${count('FAIL')} fail · ${count('INSUFFICIENT_EVIDENCE')} insufficient evidence · ${count('NOT_INSPECTED')} not inspected.</p>
${geo ? `<p>Laser scan vs CAD: ${esc(geo.status)} · coverage ${geo.coverage !== undefined ? (geo.coverage * 100).toFixed(1) + '%' : 'n/a'} · RMS deviation ${esc(geo.rmsDeviationMm ?? geo.rmseMm ?? 'n/a')} mm · p95 ${esc(geo.p95DeviationMm ?? 'n/a')} mm · fitness ${esc(geo.fitness ?? 'n/a')} · ${esc(geo.chunks ?? 0)} chunks</p>` : ''}
<h2>Findings</h2>
<table><tr><th>Rule</th><th>Title</th><th>Status</th><th>Pinned citation</th><th>Observation and evidence</th></tr>${rows}</table>
${incomplete ? `<h2>Incomplete analysis</h2><ul>${incomplete}</ul>` : ''}
<h2>Not evaluated from session evidence</h2><ul>${reference || '<li>None</li>'}</ul>
<h2>Evidence register</h2>
<table><tr><th>Type</th><th>File</th><th>Source</th><th>Bytes</th><th>sha256</th><th>Analysis</th></tr>${register}</table>
<p>Human review required. Findings are observations checked against pinned rules; they do not establish crack depth, leak tightness or bolt torque, and this dossier is not a certification or release.</p>`;
}

export async function buildServer() {
  await logger.init();
  logger.info('argus api starting', { cloudLogging: logger.cloudEnabled });
  db = loadDB(); eventSeqs.clear();
  if (process.env.MONGODB_URI) {
    try {
      await mongoStore.connect();
      const fromMongo = await mongoStore.loadState();
      // Mongo is the source of truth when configured: even an empty Atlas
      // database wins over any stale local data/db.json working state.
      db = { ...emptyDB(), ...(fromMongo || {}) } as DB;
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
      console.log('[argus] MongoDB connected; collections synced');
    } catch (e: any) {
      console.error('[argus] MongoDB connect failed, using local store; retrying every 30 s:', e?.message || e);
      // Keep trying: when MongoDB becomes reachable (e.g. after an IP
      // allow-list change), merge what was recorded meanwhile into it
      // instead of overwriting either side.
      const retry = setInterval(async () => {
        try {
          await mongoStore.connect();
          clearInterval(retry);
          const remote = await mongoStore.loadState();
          db = { ...emptyDB(), ...mergeStates(db as any, (remote || emptyDB()) as any) } as DB;
          await mongoStore.syncState(db as any);
          saveDB(db);
          console.log('[argus] MongoDB connected after retry; local and stored state merged');
        } catch { /* still unreachable */ }
      }, Number(process.env.MONGO_RETRY_MS || 30000));
      retry.unref?.();
    }
  }
  const INSPECTION_URL = process.env.INSPECTION_SERVICE_URL || 'http://localhost:8100';
  const EVIDENCE_BASE = process.env.EVIDENCE_BASE_URL || 'http://localhost:8000';
  const CLOSE_DRAIN_TIMEOUT_MS = Number(process.env.CLOSE_DRAIN_TIMEOUT_MS || 120000);
  const MAX_ORDER_UPLOAD_MB = Number(process.env.MAX_ORDER_UPLOAD_MB || 25);
  const VIDEO_ANALYSIS_EVERY = Math.max(1, Number(process.env.VIDEO_ANALYSIS_EVERY || 4));
  const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);

  const getInsp = (id: string) => db.inspections.find((i: any) => i.id === id);
  const writable = (insp: any) => !!insp && !CLOSED.includes(insp.lifecycleStatus);
  /** Order grouping derived from the pinned order document (works for
   * inspections created before grouping existed). Display only. */
  function group(insp: any) {
    const order = snapshotFor(insp).orderDocument;
    if (!order) return { orderNumber: null, assetId: null, groupKey: null };
    const doc = db.documents.find(d => d.documentId === order.documentId);
    const assetId = assetIdFrom(doc?.extraction?.context || '');
    return { orderNumber: order.orderNumber || null, assetId, groupKey: groupKeyOf(order.orderNumber || null, assetId) };
  }
  const fileUrl = (insp: any, ev: any) => `${EVIDENCE_BASE}/api/v1/inspections/${insp.id}/evidence/${ev.evidenceId}/file`;

  /** Lifecycle from facts: evidence received, jobs pending, producer done.
   * FINALIZING and the closed states are set only by operator actions. */
  function updateLifecycle(insp: any) {
    if (!insp || CLOSED.includes(insp.lifecycleStatus) || insp.lifecycleStatus === 'FINALIZING') return;
    const ev = db.evidence.filter(e => e.sessionId === insp.id).length;
    const next = !ev ? 'WAITING' : queue.pending(insp.id, DISPLAY_ONLY).length ? 'ANALYZING' : insp.producerComplete ? 'READY_TO_CLOSE' : 'RECEIVING';
    if (next !== insp.lifecycleStatus) { insp.lifecycleStatus = next; emit(db, insp.id, 'source.state', { lifecycleStatus: next }); }
    if (next === 'READY_TO_CLOSE') scheduleAutoClose(insp);
  }
  /** Auto-close (demo default): once the feed is complete and every
   * gating analysis job has finished, End the inspection automatically
   * after AUTO_CLOSE_MS. Display-only work (SAM video tracking) keeps
   * running in the background and is not waited for. AUTO_CLOSE_MS<0
   * restores the manual End step. */
  const AUTO_CLOSE_MS = Number(process.env.AUTO_CLOSE_MS ?? 5000);
  const autoCloseTimers = new Map<string, NodeJS.Timeout>();
  function scheduleAutoClose(insp: any) {
    if (AUTO_CLOSE_MS < 0 || autoCloseTimers.has(insp.id)) return;
    const t = setTimeout(() => {
      autoCloseTimers.delete(insp.id);
      const cur = getInsp(insp.id);
      if (!cur || cur.lifecycleStatus !== 'READY_TO_CLOSE') return;
      cur.lifecycleStatus = 'FINALIZING'; cur.closeRequestedAt = new Date().toISOString(); cur.closureMode = 'full'; cur.autoClosed = true;
      emit(db, cur.id, 'inspection.finalizing', { closureMode: 'full', auto: true }); saveDB(db);
      void finalize(cur, false).catch((e: any) => { cur.finalizeError = String(e?.message || e); emit(db, cur.id, 'inspection.error', { message: cur.finalizeError }); saveDB(db); });
    }, AUTO_CLOSE_MS);
    t.unref?.();
    autoCloseTimers.set(insp.id, t);
  }
  function refresh(insp: any) {
    updateLifecycle(insp);
    const ev = db.evidence.filter((e: any) => e.sessionId === insp.id);
    const applicable = sessionRules(insp).filter((r: any) => r.status !== 'NOT_APPLICABLE');
    if (!CLOSED.includes(insp.lifecycleStatus)) insp.outcome = aggregateOutcome(applicable.map((r: any) => r.status));
    insp.counts = { evidence: ev.length, video: ev.filter((e: any) => e.mediaType === 'video').length, photo: ev.filter((e: any) => e.mediaType === 'photo').length, pointcloud: ev.filter((e: any) => e.mediaType === 'pointcloud').length };
    const sts = applicable.map((r: any) => r.status);
    const cc = (s: string) => sts.filter((x: string) => x === s).length;
    insp.findings = { pass: cc('PASS'), warning: cc('WARNING'), fail: cc('FAIL'), insufficient: cc('INSUFFICIENT_EVIDENCE'), unchecked: cc('NOT_INSPECTED'), total: sts.length };
    Object.assign(insp, group(insp));
    insp.stageLabel = modelFor(insp.model_id)?.display_name || insp.model_id;
    insp.analysis = { pending: queue.pending(insp.id, DISPLAY_ONLY).length, done: ev.filter(e => e.processingStatus === 'done').length };
  }

  const queue = new AnalysisQueue(
    { visual: Number(process.env.ANALYSIS_CONCURRENCY || 6), geometry: 1, tracking: 1 },
    (job: Job) => {
      const insp = getInsp(job.sessionId);
      const ev = job.evidenceId ? db.evidence.find(e => e.evidenceId === job.evidenceId && e.sessionId === job.sessionId) : null;
      if (ev && writable(insp) && job.state !== 'cancelled') {
        ev.processingStatus = ({ queued: 'queued', running: 'processing', done: 'done', failed: 'failed' } as any)[job.state] || ev.processingStatus;
        if (job.state === 'failed') ev.processingError = job.error;
        emit(db, job.sessionId, 'evidence.processing', { evidenceId: ev.evidenceId, processingStatus: ev.processingStatus });
      }
      if (insp && writable(insp)) updateLifecycle(insp);
      saveDB(db);
    });

  /** Persist one verdict as a finding revision (never overwrite history).
   * Visual verdicts from a later item only replace a stronger earlier one;
   * geometry verdicts come from the whole merged scan and always supersede. */
  function applyVerdict(insp: any, v: { ruleId: string; status: string; reason: string; evidenceId: string | null }, supersede = false) {
    if (!writable(insp)) return false;
    const prev = db.findings.filter((f: any) => f.sessionId === insp.id && f.ruleId === v.ruleId).sort((a: any, b: any) => b.revision - a.revision)[0];
    const rank: Record<string, number> = { FAIL: 4, WARNING: 3, PASS: 2, INSUFFICIENT_EVIDENCE: 1 };
    if (!supersede && prev && prev.ruleStatus !== 'INSUFFICIENT_EVIDENCE' && (rank[v.status] || 0) < (rank[prev.ruleStatus] || 0)) return false;
    if (prev && prev.ruleStatus === v.status && prev.reason === v.reason) return false;
    const evidenceIds = [...new Set([...(prev?.evidenceIds || []), ...(v.evidenceId ? [v.evidenceId] : [])])];
    db.findings.push({ findingId: prev?.findingId || `f-${insp.id}-${v.ruleId}`, revision: (prev?.revision || 0) + 1, sessionId: insp.id, ruleId: v.ruleId, ruleStatus: v.status, featureId: prev?.featureId ?? null, evidenceIds, observationIds: [], reason: v.reason, cadAnchor: null, at: new Date().toISOString() });
    emit(db, insp.id, prev ? 'finding.updated' : 'finding.created', { ruleId: v.ruleId, ruleStatus: v.status, evidenceId: v.evidenceId });
    return true;
  }

  /** POST JSON to the inspection service. Plain node:http rather than
   * fetch: fetch gives up when response headers take longer than 300 s,
   * and SAM video tracking / long visual screens legitimately do. The only
   * limits are `timeoutMs` and the caller's abort signal. */
  function postJson(url: string, body: any, signal?: AbortSignal, timeoutMs = 1200000): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = new URL(url); const payload = Buffer.from(JSON.stringify(body));
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 0) >= 400) return reject(new Error(`${u.pathname} ${res.statusCode}: ${text.slice(0, 200)}`));
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new Error(`${u.pathname} timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      const onAbort = () => req.destroy(new Error('aborted'));
      signal?.addEventListener('abort', onAbort);
      req.on('error', reject);
      req.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
      req.end(payload);
    });
  }

  /** POST JSON, expect bytes back (the ReportAgent's PDF). */
  function postForBytes(url: string, body: any, timeoutMs = 120000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const u = new URL(url); const payload = Buffer.from(JSON.stringify(body));
      const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
        res.on('end', () => (res.statusCode || 0) >= 400 ? reject(new Error(`${u.pathname} ${res.statusCode}`)) : resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new Error(`${u.pathname} timed out`)), timeoutMs);
      req.on('error', reject); req.on('close', () => clearTimeout(timer)); req.end(payload);
    });
  }

  /** Dossier PDF via the ReportAgent; stored next to the HTML. */
  /** Advisory AI summary of a closed inspection (Muse Wonder via the
   * orchestrator). Reasoning + recommended action for the engineer; it
   * never changes a verdict and the UI labels it AI-generated. */
  async function runSummary(insp: any) {
    if (insp.aiSummary?.status === 'running') return;
    const d = db.dossiers.find(x => x.sessionId === insp.id);
    insp.aiSummary = { status: 'running', at: new Date().toISOString() };
    emit(db, insp.id, 'summary.updated', { status: 'running' }); saveDB(db);
    try {
      const out = await postJson(`${INSPECTION_URL}/inspection-summary`, dossierData(insp, !!d?.partial), undefined, Number(process.env.SUMMARY_TIMEOUT_MS || 180000));
      if (!out?.summary) throw new Error('empty summary');
      insp.aiSummary = { status: 'ready', summary: out.summary, action: out.action, actionReason: out.actionReason || '', nextSteps: out.nextSteps || [], model: out.model, at: new Date().toISOString() };
    } catch (e: any) {
      insp.aiSummary = { status: 'failed', reason: String(e?.message || e).slice(0, 200), at: new Date().toISOString() };
      logger.info('summary.failed', { sessionId: insp.id, reason: insp.aiSummary.reason });
    }
    emit(db, insp.id, 'summary.updated', { status: insp.aiSummary.status }); saveDB(db);
  }

  async function buildDossierPdf(insp: any): Promise<string | null> {
    const d = db.dossiers.find(x => x.sessionId === insp.id); if (!d) return null;
    try {
      const pdf = await postForBytes(`${INSPECTION_URL}/dossier/pdf`, dossierData(insp, !!d.partial));
      if (!pdf.subarray(0, 4).equals(Buffer.from('%PDF'))) throw new Error('not a PDF');
      const file = path.join(DATA, 'dossiers', `${insp.id}.pdf`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, pdf);
      Object.assign(d, { pdfPath: path.relative(DATA, file), pdfSize: pdf.length, pdfSha256: sha256(pdf), pdfError: null });
      saveDB(db); return file;
    } catch (e: any) {
      d.pdfError = String(e?.message || e).slice(0, 200); saveDB(db);
      logger.info('dossier.pdf_failed', { sessionId: insp.id, reason: d.pdfError });
      return null;
    }
  }

  /** One photo or video segment: SAM routing + Muse screening against the
   * pinned rules. Rules already decided by earlier video are not re-screened. */
  async function runVisual(insp: any, ev: any, signal: AbortSignal) {
    const snap = snapshotFor(insp);
    const decided = ev.mediaType === 'video' ? latestFindings(db.findings, insp.id).filter(f => DECIDED.includes(f.ruleStatus)).map(f => f.ruleId) : [];
    const orderDoc = snap.orderDocument ? db.documents.find(d => d.documentId === snap.orderDocument.documentId) : null;
    const data = await postJson(`${INSPECTION_URL}/analyze-evidence`, {
      sessionId: insp.id, model_id: insp.model_id, family: snap.model.family, type: snap.model.type,
      rules: snap.rules.filter(evaluable), orderContext: orderDoc?.extraction?.context || null, skipRuleIds: decided,
      evidences: [{ eventId: ev.eventId, evidenceId: ev.evidenceId, mediaType: ev.mediaType, filename: ev.filename, url: fileUrl(insp, ev) }],
    }, signal);
    if (signal.aborted || !writable(insp)) return;  // closed meanwhile: never write late results
    for (const obs of data.observations || []) {
      if (obs.kind === 'detections') {
        const observationId = `obs-${ev.evidenceId}-sam`;
        db.observations = db.observations.filter(o => o.observationId !== observationId);
        db.observations.push({ observationId, sessionId: insp.id, evidenceId: ev.evidenceId, kind: 'segmentation', model: obs.model, at: new Date().toISOString(), payload: { components: obs.components } });
        ev.detectedComponents = (obs.components || []).filter((c: any) => c.boxes && !c.error).map((c: any) => c.id);
        emit(db, insp.id, 'observation.created', { evidenceId: ev.evidenceId, observationId, kind: 'segmentation', components: ev.detectedComponents });
        continue;
      }
      const v = verdictFromObservation(obs);
      if (v) applyVerdict(insp, v);
    }
    emit(db, insp.id, 'rule.progress', {});
  }

  function enqueueVisual(insp: any, ev: any) {
    queue.enqueue(insp.id, `visual:${ev.evidenceId}`, 'visual', (signal) => runVisual(insp, ev, signal), ev.evidenceId);
  }

  /** Video is analysed one segment in VIDEO_ANALYSIS_EVERY (plus the last
   * one at /complete); the others are recorded as sampled out. */
  function scheduleEvidence(insp: any, ev: any) {
    if (ev.mediaType === 'photo') return enqueueVisual(insp, ev);
    if (ev.mediaType === 'video') {
      const idx = orderVideos(db.evidence.filter(e => e.sessionId === insp.id)).findIndex(e => e.evidenceId === ev.evidenceId);
      if (idx % VIDEO_ANALYSIS_EVERY === 0) return enqueueVisual(insp, ev);
      ev.processingStatus = 'sampled_out';
      ev.processingNote = `Video analysed one segment in ${VIDEO_ANALYSIS_EVERY}; this segment was not sent to the models.`;
      return;
    }
    if (ev.mediaType === 'pointcloud') scheduleGeometry(insp);
  }

  /** Merged-scan CAD comparison; coalesced so chunks arriving mid-run
   * trigger exactly one more run with the larger scan. */
  function scheduleGeometry(insp: any) {
    queue.enqueue(insp.id, `geometry:${insp.id}`, 'geometry', (signal) => runComparison(insp, signal));
  }

  /** Display-only: track the session's relevant components through the
   * merged video (SAM 3.1 video, low-fps proxy). Allowed on closed
   * sessions too — it never touches findings, only adds an overlay. */
  const videoSig = (insp: any) => { const v = orderVideos(db.evidence.filter(e => e.sessionId === insp.id)); return v.length ? `${v.length}-${v[v.length - 1].evidenceId}` : ''; };
  function scheduleTracking(insp: any) {
    if (!orderVideos(db.evidence.filter(e => e.sessionId === insp.id)).length) return false;
    insp.videoTracking = { status: 'queued', at: new Date().toISOString() };
    queue.enqueue(insp.id, `tracking:${insp.id}`, 'tracking', (signal) => runTracking(insp, signal));
    return true;
  }
  async function runTracking(insp: any, signal: AbortSignal) {
    const sig = videoSig(insp);
    insp.videoTracking = { status: 'running', at: new Date().toISOString() }; saveDB(db);
    try {
      await mergedVideoFile(insp);
      const snap = snapshotFor(insp);
      const data = await postJson(`${INSPECTION_URL}/track-video`, {
        sessionId: insp.id, url: `${EVIDENCE_BASE}/api/v1/inspections/${insp.id}/video/merged?v=${encodeURIComponent(sig)}`, filename: 'merged.mp4',
        family: snap.model.family, type: snap.model.type, rules: snap.rules.filter(evaluable),
      }, signal, 1800000);
      if (signal.aborted) return;
      const observationId = `obs-${insp.id}-video-tracks`;
      db.observations = db.observations.filter(o => o.observationId !== observationId);
      db.observations.push({ observationId, sessionId: insp.id, evidenceId: null, kind: 'video_tracks', model: data.model, at: new Date().toISOString(), payload: { ...data, videoSignature: sig } });
      insp.videoTracking = { status: data.status === 'ready' ? 'ready' : data.status || 'failed', reason: data.reason, at: new Date().toISOString() };
      emit(db, insp.id, 'observation.created', { observationId, kind: 'video_tracks' }); saveDB(db);
    } catch (e: any) {
      if (signal.aborted) return;
      insp.videoTracking = { status: 'failed', reason: String(e?.message || e).slice(0, 300), at: new Date().toISOString() }; saveDB(db);
      throw e;
    }
  }

  async function runComparison(insp: any, signal: AbortSignal) {
    const pcs = db.evidence.filter((e: any) => e.sessionId === insp.id && e.mediaType === 'pointcloud');
    if (!pcs.length) { insp.geometry = { status: 'insufficient', reason: 'No point-cloud chunks received', at: new Date().toISOString() }; saveDB(db); return; }
    insp.geometry = { ...(insp.geometry || {}), status: 'running', chunks: pcs.length, at: new Date().toISOString() }; saveDB(db);
    const snap = snapshotFor(insp);
    const scanRules = snap.rules.filter((r: any) => evaluable(r) && (r.modalities || []).includes('pointcloud') && r.threshold);
    let data: any;
    try {
      data = await postJson(`${INSPECTION_URL}/compare-merged`, {
        sessionId: insp.id, model_id: insp.model_id, rules: scanRules,
        evidences: pcs.map((e: any) => ({ eventId: e.eventId, evidenceId: e.evidenceId, mediaType: 'pointcloud', filename: e.filename, url: fileUrl(insp, e) })),
      }, signal, 600000);
    } catch (e: any) {
      if (signal.aborted || !writable(insp)) return;
      insp.geometry = { status: 'unavailable', reason: String(e?.message || e), chunks: pcs.length, at: new Date().toISOString() };
      logger.info('geometry.unavailable', { sessionId: insp.id, reason: insp.geometry.reason });
      emit(db, insp.id, 'coverage.updated', { status: insp.geometry.status }); saveDB(db);
      throw e;
    }
    if (signal.aborted || !writable(insp)) return;
    const obs = data.observation || {};
    const reg = obs.registration || pickRegistration(data.observations || []);
    insp.geometry = reg ? { status: reg.status, rmseMm: reg.rmseMm, rmsDeviationMm: reg.rmsDeviationMm ?? reg.rmseMm, p95DeviationMm: reg.p95DeviationMm, fitness: reg.fitness, coverage: reg.surfaceCoverageFraction, meanDeviationMm: reg.meanDeviationMm, scanPoints: reg.scanPoints, cadPoints: reg.cadPoints, chunks: pcs.length, at: new Date().toISOString() }
                        : { status: 'insufficient', reason: 'No geometry observation returned', chunks: pcs.length, at: new Date().toISOString() };
    const evidenceId = pcs[pcs.length - 1].evidenceId;
    for (const rr of obs.ruleResults || []) {
      const rule = scanRules.find((r: any) => r.ruleId === rr.ruleId);
      if (!rule || ['NOT_INSPECTED', 'NOT_APPLICABLE'].includes(rr.ruleStatus)) continue;
      applyVerdict(insp, { ruleId: rr.ruleId, status: rr.ruleStatus, reason: geometryReason(rule, rr.ruleStatus, { ...reg, mergedChunks: obs.mergedChunks ?? pcs.length }), evidenceId }, true);
    }
    for (const e of pcs) if (e.processingStatus !== 'done') e.processingStatus = 'done';
    logger.info('geometry.compared', { sessionId: insp.id, status: insp.geometry.status, coverage: insp.geometry.coverage });
    emit(db, insp.id, 'coverage.updated', { status: insp.geometry.status, coverage: insp.geometry.coverage }); saveDB(db);
  }

  /** Close: End drains accepted analysis up to CLOSE_DRAIN_TIMEOUT_MS and
   * records whatever did not finish; Terminate cancels at once. Either
   * way intake is sealed first and late results are discarded. */
  async function finalize(insp: any, terminated: boolean) {
    let leftover: Job[] = [];
    if (!terminated) {
      const { remaining } = await queue.drain(insp.id, CLOSE_DRAIN_TIMEOUT_MS, DISPLAY_ONLY);
      if (remaining.length) leftover = queue.cancel(insp.id, DISPLAY_ONLY);
    } else leftover = queue.cancel(insp.id, DISPLAY_ONLY);
    insp.incompleteAnalysis = leftover.map(j => ({ kind: j.kind, evidenceId: j.evidenceId || null, reason: terminated ? 'Cancelled by Terminate Now' : `Not finished within ${Math.round(CLOSE_DRAIN_TIMEOUT_MS / 1000)} s drain window` }));
    for (const j of leftover) {
      const ev = j.evidenceId ? db.evidence.find(e => e.evidenceId === j.evidenceId && e.sessionId === insp.id) : null;
      if (ev) ev.processingStatus = 'cancelled';
    }
    for (const ev of db.evidence.filter(e => e.sessionId === insp.id && e.processingStatus === 'queued')) ev.processingStatus = 'cancelled';
    const statuses = sessionRules(insp).map((r: any) => r.status);
    insp.lifecycleStatus = terminated ? 'TERMINATED' : 'COMPLETED'; insp.closedAt = new Date().toISOString();
    insp.outcome = aggregateOutcome(statuses, terminated);
    refresh(insp);
    const html = dossierHtml(insp, terminated); const dir = path.join(DATA, 'dossiers'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${insp.id}.html`), html);
    db.dossiers = db.dossiers.filter(d => d.sessionId !== insp.id);
    db.dossiers.push({ sessionId: insp.id, partial: terminated, outcome: insp.outcome, size: Buffer.byteLength(html), at: insp.closedAt, htmlPath: path.relative(DATA, path.join(dir, `${insp.id}.html`)), sha256: sha256(html) });
    await buildDossierPdf(insp);
    void runSummary(insp);
    emit(db, insp.id, 'inspection.closed', { lifecycleStatus: insp.lifecycleStatus, outcome: insp.outcome }); emit(db, insp.id, 'dossier.ready', {}); saveDB(db);
    logger.info('inspection.closed', { sessionId: insp.id, lifecycleStatus: insp.lifecycleStatus, outcome: insp.outcome, incomplete: leftover.length });
  }

  /** Store an uploaded customer specification / work order and extract
   * its text and printed order rules (Python service, pypdf). */
  async function attachOrderDocument(insp: any, filename: string, buf: Buffer) {
    const documentId = `doc-${insp.id}-${Date.now().toString(36)}`;
    const dir = path.join(DATA, 'documents', insp.id); fs.mkdirSync(dir, { recursive: true });
    const storagePath = path.join(dir, `${documentId}-${path.basename(filename)}`);
    fs.writeFileSync(storagePath, buf);
    await putObjectIfConfigured(`documents/${insp.id}/${documentId}-${path.basename(filename)}`, buf).catch(() => null);
    const doc: any = { documentId, sessionId: insp.id, kind: 'order', name: path.basename(filename), size: buf.length, sha256: sha256(buf), at: new Date().toISOString(), storagePath: path.relative(DATA, storagePath), extraction: { status: 'failed' } };
    db.documents.push(doc);
    let rules: any[] = [];
    try {
      const out = await postJson(`${INSPECTION_URL}/documents/extract`, { url: `${EVIDENCE_BASE}/api/v1/inspections/${insp.id}/documents/${documentId}/file`, filename: doc.name }, undefined, 60000);
      rules = out.rules || [];
      doc.extraction = { status: 'parsed', pages: out.pages, orderNumber: out.orderNumber, ruleCount: rules.length, context: out.context };
    } catch (e: any) {
      doc.extraction = { status: 'failed', error: String(e?.message || e).slice(0, 300) };
    }
    return { ...doc, orderNumber: doc.extraction.orderNumber || null, rules };
  }

  async function readOrderUpload(req: any): Promise<{ fields: Record<string, string>; file: { filename: string; buf: Buffer } | null; error?: { code: number; body: any } }> {
    const fields: Record<string, string> = {}; let file: any = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: MAX_ORDER_UPLOAD_MB * 1024 * 1024 } })) {
        if (part.type === 'field') fields[part.fieldname] = String((part as any).value ?? '');
        else if (part.type === 'file') {
          const ext = path.extname(part.filename || '').toLowerCase();
          if (!ORDER_EXTENSIONS.includes(ext)) { await part.toBuffer().catch(() => null); return { fields, file: null, error: { code: 415, body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: `Order document must be ${ORDER_EXTENSIONS.join(', ')}` } } } }; }
          file = { filename: part.filename, buf: await part.toBuffer() };
        }
      }
    } catch (e: any) {
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || /too large/i.test(e?.message || '')) return { fields, file: null, error: { code: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE', message: `Order document exceeds ${MAX_ORDER_UPLOAD_MB} MB` } } } };
      throw e;
    }
    return { fields, file };
  }

  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });
  app.get('/api/v1/health', async () => ({ ok: true, storage: { ...storageMode, mongoConfigured: storageMode.mongo, mongo: mongoStore.connected } }));
  app.get('/api/v1/cad-models/:model_id/reference.ply', async (req: any, reply) => {
    const model = modelFor(req.params.model_id);
    const file = model && cadReferencePath(model);
    if (!file) return reply.code(404).send({ error: 'no CAD reference for model' });
    const max = Math.min(Math.max(Number(req.query.sample) || 80000, 1000), 680000);
    return reply.type('application/octet-stream').send(samplePlyBuffer(fs.readFileSync(file), max));
  });
  app.get('/api/v1/cad-models', async () => ({ cad_models: cadModels }));
  app.get('/api/v1/instruction-sets', async () => loadRuleIndex());

  app.post('/api/v1/inspections', async (req: any, reply) => {
    let body: any = req.body || {}; let upload: any = null;
    if (req.isMultipart?.()) {
      const parsed = await readOrderUpload(req);
      if (parsed.error) return reply.code(parsed.error.code).send(parsed.error.body);
      body = parsed.fields; upload = parsed.file;
    }
    const name = (body.name || '').trim();
    if (!name) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Inspection name is required' } });
    if (body.model_id && !modelFor(body.model_id)) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Unknown model_id' } });
    const model = modelFor(body.model_id) || cadModels[0];
    const insp: any = { id: `insp-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, name, model_id: model.model_id, family: model.family, type: model.type, cadRevision: model.revision, cadSha256: model.sha256, lifecycleStatus: 'WAITING', outcome: 'PENDING', createdAt: new Date().toISOString(), counts: { evidence: 0, video: 0, photo: 0, pointcloud: 0 }, producerComplete: false };
    db.inspections.push(insp);
    const order = upload ? await attachOrderDocument(insp, upload.filename, upload.buf) : null;
    pinSnapshot(insp, order);
    emit(db, insp.id, 'inspection.created', { referenceSnapshotId: insp.referenceSnapshotId }); saveDB(db);
    // Warm SAM 3.1 while the operator starts the feed (fire and forget).
    postJson(`${INSPECTION_URL}/warmup`, {}, undefined, 10000).catch(() => {});
    logger.info('inspection.created', { sessionId: insp.id, model_id: insp.model_id, orderDocument: !!order });
    return reply.code(201).send(insp);
  });
  app.post('/api/v1/inspections/:id/order-document', async (req: any, reply) => {
    const insp = getInsp(req.params.id);
    if (!insp) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    if (insp.lifecycleStatus !== 'WAITING') return reply.code(409).send({ error: { code: 'SNAPSHOT_FROZEN', message: 'The rule snapshot is frozen once evidence arrives; attach the order document before sending evidence.' } });
    const parsed = await readOrderUpload(req);
    if (parsed.error) return reply.code(parsed.error.code).send(parsed.error.body);
    if (!parsed.file) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'file required' } });
    const order = await attachOrderDocument(insp, parsed.file.filename, parsed.file.buf);
    const snap = pinSnapshot(insp, order);
    emit(db, insp.id, 'inspection.snapshot', { referenceSnapshotId: snap.snapshotId }); saveDB(db);
    return reply.code(201).send({ snapshotId: snap.snapshotId, cascade: snap.cascade, document: { documentId: order.documentId, name: order.name, extraction: order.extraction } });
  });
  app.get('/api/v1/inspections', async (req: any) => {
    const q = (req.query.q || '').toLowerCase();
    const list = db.inspections.filter((i: any) => !q || i.name.toLowerCase().includes(q) || i.id.includes(q)).slice().reverse();
    list.forEach(refresh);
    return { inspections: list, counts: { total: list.length, active: list.filter((i: any) => !CLOSED.includes(i.lifecycleStatus)).length, completed: list.filter((i: any) => i.lifecycleStatus === 'COMPLETED').length, terminated: list.filter((i: any) => i.lifecycleStatus === 'TERMINATED').length } };
  });

  app.get('/api/v1/inspections/:id', async (req: any, reply) => { const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } }); refresh(i); return i; });
  app.get('/api/v1/inspections/:id/rules', async (req: any, reply) => {
    const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    const snap = snapshotFor(i); const rules = sessionRules(i);
    const order = snap.orderDocument ? db.documents.find(d => d.documentId === snap.orderDocument.documentId) : null;
    const m = snap.model;
    return {
      cascade: { ...snap.cascade, applicable: snap.cascade.customerSpec },
      rules,
      snapshot: { snapshotId: snap.snapshotId, revision: snap.revision, sha256: snap.sha256, libraryRevision: snap.library.revision, createdAt: snap.createdAt, legacy: !!snap.legacy },
      model: m,
      orderDocument: snap.orderDocument ? { ...snap.orderDocument, extraction: order ? { status: order.extraction.status, pages: order.extraction.pages, error: order.extraction.error } : null } : null,
      why: `${snap.cascade.valveType} of ${snap.cascade.library} library rules apply to a ${m.family} / ${String(m.type).replace(/_/g, ' ')} with ${m.end_connection} ends (pinned CAD ${m.model_id}); ${snap.cascade.filteredOut} are for other valve types or end connections. ${snap.cascade.customerSpec} of them can be evaluated from photos, video or the laser scan${snap.orderDocument ? `, including ${snap.cascade.orderRules} rules printed in ${snap.orderDocument.orderNumber || snap.orderDocument.name}` : ''}; ${snap.cascade.referenceOnly} need measurement, functional-test or work-order records. SAM component routing applies only the routed subset to each photo/video.`,
    };
  });
  app.get('/api/v1/inspections/:id/evidence', async (req: any) => db.evidence.filter((e: any) => e.sessionId === req.params.id).map((e: any) => ({ ...e, detections: undefined })));
  app.get('/api/v1/inspections/:id/observations', async (req: any) => db.observations.filter((o: any) => o.sessionId === req.params.id && (!req.query.evidenceId || o.evidenceId === req.query.evidenceId)));

  const mergedInFlight = new Map<string, Promise<string>>();
  async function mergedVideoFile(insp: any): Promise<string> {
    const vids = orderVideos(db.evidence.filter((e: any) => e.sessionId === insp.id));
    if (!vids.length) throw new Error('no video evidence');
    const sig = `${vids.length}-${vids[vids.length - 1].evidenceId}-${vids.reduce((s: number, e: any) => s + (e.size || 0), 0)}`;
    const dir = path.join(DATA, 'merged'); fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${insp.id}-${sig}.mp4`);
    if (fs.existsSync(out)) return out;
    if (mergedInFlight.has(out)) return mergedInFlight.get(out)!;
    const job = (async () => {
      const { execFile } = await import('node:child_process');
      const run = (args: string[]) => new Promise<void>((resolve, reject) => execFile('ffmpeg', args, (err) => err ? reject(err) : resolve()));
      const listFile = path.join(dir, `${insp.id}-${sig}.txt`);
      const lines = vids.map((e: any) => `file '${path.join(DATA, 'evidence', e.sessionId, `${e.evidenceId}-${e.filename}`).replace(/'/g, `'\\''`)}'`).join('\n');
      fs.writeFileSync(listFile, lines);
      const tmp = `${out}.tmp.mp4`;
      try { await run(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', tmp]); }
      catch { await run(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-preset', 'veryfast', '-an', tmp]); }
      fs.renameSync(tmp, out);
      fs.rmSync(listFile, { force: true });
      logger.info('video.merged', { sessionId: insp.id, segments: vids.length });
      return out;
    })();
    mergedInFlight.set(out, job);
    try { return await job; } finally { mergedInFlight.delete(out); }
  }
  app.get('/api/v1/inspections/:id/video/merged', async (req: any, reply) => {
    const insp = getInsp(req.params.id);
    if (!insp) return reply.code(404).send({ error: 'not found' });
    let file: string;
    try { file = await mergedVideoFile(insp); }
    catch (e: any) { return reply.code(503).send({ error: `merged video unavailable: ${e?.message || e}` }); }
    const size = fs.statSync(file).size;
    const range = parseRange(req.headers.range, size);
    reply.type('video/mp4').header('Accept-Ranges', 'bytes');
    if (range) {
      return reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`).header('Content-Length', range.end - range.start + 1)
        .send(fs.createReadStream(file, { start: range.start, end: range.end }));
    }
    return reply.header('Content-Length', size).send(fs.createReadStream(file));
  });
  /** Earlier inspections of the same order / asset, and how each rule
   * stood in them. Display only: never changes this inspection's results. */
  app.get('/api/v1/inspections/:id/history', async (req: any, reply) => {
    const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    const g = group(i);
    if (!g.groupKey) return { ...g, previous: [], rules: [] };
    const previous = db.inspections.filter(x => x.id !== i.id && x.createdAt < i.createdAt && group(x).groupKey === g.groupKey)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    previous.forEach(refresh);
    const prevRules = new Map(previous.map(p => [p.id, new Map(sessionRules(p).map((r: any) => [r.ruleId, r]))]));
    const rules = sessionRules(i).filter((r: any) => r.status !== 'NOT_APPLICABLE').map((r: any) => ({
      ruleId: r.ruleId, code: r.code || r.ruleId, title: r.title, section: r.section, current: r.status,
      previous: previous.map(p => { const pr: any = prevRules.get(p.id)?.get(r.ruleId); return { sessionId: p.id, status: pr ? pr.status : 'NOT_IN_SCOPE', reason: pr?.finding?.reason || null }; }),
    })).filter((r: any) => r.previous.some((p: any) => !['NOT_INSPECTED', 'NOT_IN_SCOPE', 'NOT_APPLICABLE'].includes(p.status)));
    return { ...g, previous: previous.map(p => ({ id: p.id, name: p.name, stageLabel: modelFor(p.model_id)?.display_name || p.model_id, createdAt: p.createdAt, closedAt: p.closedAt || null, lifecycleStatus: p.lifecycleStatus, outcome: p.outcome, findings: p.findings })), rules };
  });
  app.post('/api/v1/inspections/:id/track-video', async (req: any, reply) => {
    const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    if (!scheduleTracking(i)) return reply.code(409).send({ error: { code: 'NO_VIDEO', message: 'No video received in this session' } });
    saveDB(db); return reply.code(202).send({ ok: true, status: 'queued' });
  });
  app.get('/api/v1/inspections/:id/video/annotations', async (req: any, reply) => {
    const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    const obs = db.observations.find(o => o.sessionId === i.id && o.kind === 'video_tracks');
    const state = i.videoTracking?.status || (obs ? 'ready' : 'none');
    if (!obs) return { status: state, reason: i.videoTracking?.reason || null, labels: [], components: [] };
    const t = obs.payload;
    return { status: state, reason: i.videoTracking?.reason || null, fps: t.fps, width: t.width, height: t.height, duration: t.duration, model: obs.model,
      videoSignature: t.videoSignature, current: t.videoSignature === videoSig(i),
      components: (t.components || []).map((c: any) => ({ id: c.id, prompt: c.prompt, objects: c.objects || [], error: c.error || null })),
      labels: videoLabels(sessionRules(i), t) };
  });
  app.get('/api/v1/inspections/:id/evidence/:evidenceId/file', async (req: any, reply) => {
    const ev = db.evidence.find((e: any) => e.sessionId === req.params.id && e.evidenceId === req.params.evidenceId);
    if (!ev) return reply.code(404).send({ error: 'evidence not found' });
    const fp = path.join(DATA, 'evidence', ev.sessionId, `${ev.evidenceId}-${ev.filename}`);
    if (!fs.existsSync(fp)) return reply.code(404).send({ error: 'evidence bytes not found' });
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.ply': 'application/octet-stream', '.pcd': 'application/octet-stream' };
    return reply.type(mime[path.extname(ev.filename).toLowerCase()] || 'application/octet-stream').send(fs.createReadStream(fp));
  });
  app.get('/api/v1/inspections/:id/findings', async (req: any) => db.findings.filter((f: any) => f.sessionId === req.params.id));

  /** Pinned references of a session: CAD baseline, rule snapshot, order
   * document, plus the dossier once generated. Each is downloadable. */
  function pinnedDocuments(insp: any) {
    const snap = snapshotFor(insp);
    const model = modelFor(insp.model_id);
    const cadPath = model?.cad_file ? path.join(root, 'src', model.cad_file) : '';
    const snapJson = JSON.stringify(snap, null, 2);
    const docs: any[] = [];
    if (model?.cad_file) docs.push({ docId: 'cad', name: path.basename(model.cad_file), type: 'cad', kind: 'CAD baseline', size: fs.existsSync(cadPath) ? fs.statSync(cadPath).size : 0, source: 'Pinned reference', at: insp.createdAt, when: '00:00', sha256: insp.cadSha256, path: cadPath, mime: 'model/stl' });
    docs.push({ docId: 'rule-snapshot', name: `rule-snapshot-${insp.id}.json`, type: 'rules', kind: 'Rule snapshot', size: Buffer.byteLength(snapJson), source: `Pinned at creation · ${snap.snapshotId}`, at: snap.createdAt, when: '00:00', sha256: sha256(snapJson), content: snapJson, mime: 'application/json' });
    for (const d of db.documents.filter(x => x.sessionId === insp.id && x.documentId === snap.orderDocument?.documentId)) {
      docs.push({ docId: d.documentId, name: d.name, type: 'order', kind: 'Customer specification', size: d.size, source: d.extraction?.status === 'parsed' ? `Uploaded · ${d.extraction.orderNumber || 'order'} · ${d.extraction.ruleCount} rules read` : `Uploaded · rules could not be read`, at: d.at, when: '00:00', sha256: d.sha256, path: path.join(DATA, d.storagePath), mime: ({ '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as any)[path.extname(d.name).toLowerCase()] || 'application/octet-stream' });
    }
    for (const d of db.dossiers.filter(x => x.sessionId === insp.id)) docs.push({ docId: 'dossier', name: `${insp.id}_dossier.pdf`, type: 'Report', kind: 'Report (PDF)', size: d.pdfSize || d.size, source: 'Generated at closure by the ReportAgent', at: d.at, when: 'At closure', sha256: d.pdfSha256 || d.sha256 || null, path: d.pdfPath ? path.join(DATA, d.pdfPath) : dossierFile(d), mime: d.pdfPath ? 'application/pdf' : 'text/html' });
    return docs;
  }
  app.get('/api/v1/inspections/:id/documents', async (req: any, reply) => {
    const insp = getInsp(req.params.id); if (!insp) return reply.code(404).send({ error: 'not found' });
    const ev = db.evidence.filter((e: any) => e.sessionId === req.params.id);
    const rel = (at: string) => { const s = Math.max(0, Math.round((new Date(at).getTime() - new Date(insp.createdAt).getTime()) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    const docs = [...ev.map((e: any) => ({ name: e.filename, type: e.mediaType, size: e.size, source: e.sourceId, synthetic: e.synthetic, at: e.at, when: rel(e.at), evidenceId: e.evidenceId, sha256: e.sha256, processingStatus: e.processingStatus })),
      ...pinnedDocuments(insp).map(({ path: _p, content: _c, ...d }) => ({ ...d, url: `/api/v1/inspections/${insp.id}/documents/${d.docId}/file` }))];
    return { documents: docs, total: docs.length };
  });
  app.get('/api/v1/inspections/:id/documents/:docId/file', async (req: any, reply) => {
    const insp = getInsp(req.params.id); if (!insp) return reply.code(404).send({ error: 'not found' });
    // Uploaded documents are served straight from storage: the inspection
    // service downloads an order document while the session is still being
    // created, before its snapshot exists, so this must not touch it.
    const uploaded = db.documents.find(x => x.sessionId === insp.id && x.documentId === req.params.docId);
    const d = uploaded ? { name: uploaded.name, path: path.join(DATA, uploaded.storagePath), mime: 'application/octet-stream' } as any
      : pinnedDocuments(insp).find(x => x.docId === req.params.docId);
    if (!d) return reply.code(404).send({ error: 'document not found' });
    reply.header('Content-Disposition', `attachment; filename="${String(d.name).replace(/"/g, '')}"`).type(d.mime || 'application/octet-stream');
    if (d.content !== undefined) return reply.send(d.content);
    if (!d.path || !fs.existsSync(d.path)) return reply.code(404).send({ error: 'document bytes not found' });
    return reply.send(fs.createReadStream(d.path));
  });

  /** SSE: persisted events in order; resumes after Last-Event-ID (header or
   * ?lastEventId=) so a reconnect never replays or skips; heartbeats keep
   * proxies from closing an idle stream. */
  app.get('/api/v1/inspections/:id/events', async (req: any, reply) => {
    const id = req.params.id;
    if (!getInsp(id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    const after = Number(req.headers['last-event-id'] ?? req.query.lastEventId ?? 0) || 0;
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('retry: 2000\n\n');
    for (const e of db.events.filter((e: any) => e.sessionId === id && e.eventSeq > after)) reply.raw.write(`id: ${e.eventSeq}\ndata: ${JSON.stringify(e)}\n\n`);
    if (!listeners.has(id)) listeners.set(id, new Set()); listeners.get(id)!.add(reply.raw);
    const beat = setInterval(() => { try { reply.raw.write(': heartbeat\n\n'); } catch {} }, SSE_HEARTBEAT_MS);
    req.raw.on('close', () => { clearInterval(beat); listeners.get(id)?.delete(reply.raw); });
  });

  const upload = (mediaType: string) => async (req: any, reply: any) => {
    if (!ingestAuthorized(req)) { logger.warn('ingest.rejected', { reason: 'bad or missing ingest token' }); return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Valid ingest token required' } }); }
    const insp = getInsp(req.params.id);
    if (!insp) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    if ([...CLOSED, 'FINALIZING'].includes(insp.lifecycleStatus)) return reply.code(409).send({ error: { code: 'SESSION_CLOSED', message: 'Session closed' } });
    let metadata: any = {}, filename = 'file', buf: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'metadata') { const v: any = (part as any).value; try { metadata = typeof v === 'string' ? JSON.parse(v) : (Buffer.isBuffer(v) ? JSON.parse(v.toString()) : v); } catch { return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Bad metadata JSON' } }); } }
      if (part.type === 'file') { filename = part.filename; buf = await part.toBuffer(); }
    }
    if (!buf) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'file required' } });
    if (mediaType === 'pointcloud' && (!metadata.units || !metadata.coordinateFrame)) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'pointcloud requires units and coordinateFrame' } });
    if (!metadata.eventId) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'eventId required' } });
    if ([...CLOSED, 'FINALIZING'].includes(insp.lifecycleStatus)) return reply.code(409).send({ error: { code: 'SESSION_CLOSED', message: 'Session closed' } });
    const digest = sha256(buf);
    const existing = db.evidence.find((e: any) => e.sessionId === insp.id && e.eventId === metadata.eventId);
    if (existing) {
      if (existing.sha256 !== digest) return reply.code(409).send({ error: { code: 'CONFLICT', message: 'eventId reused with different payload' } });
      return reply.code(202).send({ evidenceId: existing.evidenceId, accepted: true, processingStatus: 'queued' });
    }
    const dir = path.join(DATA, 'evidence', insp.id); fs.mkdirSync(dir, { recursive: true });
    const evidenceId = `ev-${metadata.eventId}`;
    fs.writeFileSync(path.join(dir, `${evidenceId}-${filename}`), buf);
    await putObjectIfConfigured(`evidence/${insp.id}/${evidenceId}-${filename}`, buf).catch(() => null);
    const ev = { evidenceId, sessionId: insp.id, eventId: metadata.eventId, sourceId: metadata.sourceId, sequence: metadata.sequence, relativeTimeMs: metadata.relativeTimeMs, mediaType, synthetic: !!metadata.synthetic, units: metadata.units, coordinateFrame: metadata.coordinateFrame, filename, size: buf.length, sha256: digest, at: new Date().toISOString(), processingStatus: 'queued' };
    db.evidence.push(ev); emit(db, insp.id, 'evidence.received', { evidenceId, mediaType });
    scheduleEvidence(insp, ev); updateLifecycle(insp); saveDB(db);
    logger.info('evidence.received', { sessionId: insp.id, evidenceId, mediaType, eventId: metadata.eventId, size: buf.length });
    return reply.code(202).send({ evidenceId, accepted: true, processingStatus: 'queued' });
  };
  app.post('/api/v1/inspections/:id/video', upload('video'));
  app.post('/api/v1/inspections/:id/photos', upload('photo'));
  app.post('/api/v1/inspections/:id/pointcloud', upload('pointcloud'));
  app.post('/api/v1/inspections/:id/complete', async (req: any, reply) => {
    if (!ingestAuthorized(req)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Valid ingest token required' } });
    const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    if (!writable(i)) return reply.code(409).send({ error: { code: 'SESSION_CLOSED', message: 'Session closed' } });
    i.producerComplete = true;
    emit(db, i.id, 'source.complete', {});
    const vids = orderVideos(db.evidence.filter(e => e.sessionId === i.id));
    const last = vids[vids.length - 1];
    if (last && last.processingStatus === 'sampled_out') { last.processingStatus = 'queued'; delete last.processingNote; enqueueVisual(i, last); }
    scheduleTracking(i);
    updateLifecycle(i); saveDB(db);
    return { ok: true, sessionOpen: true };
  });
  app.post('/api/v1/inspections/:id/compare', async (req: any, reply) => { const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: 'not found' }); if (!writable(i)) return reply.code(409).send({ error: { code: 'SESSION_CLOSED', message: 'Session closed' } }); scheduleGeometry(i); updateLifecycle(i); return { ok: true, status: 'queued' }; });
  app.post('/api/v1/inspections/:id/analyze-visual', async (req: any, reply) => {
    const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: 'not found' });
    if (!writable(i)) return reply.code(409).send({ error: { code: 'SESSION_CLOSED', message: 'Session closed' } });
    for (const ev of db.evidence.filter(e => e.sessionId === i.id && ['photo', 'video'].includes(e.mediaType) && e.processingStatus !== 'sampled_out')) enqueueVisual(i, ev);
    updateLifecycle(i); return { ok: true, status: 'queued' };
  });
  const close = (terminated: boolean) => async (req: any, reply: any) => {
    const insp = getInsp(req.params.id); if (!insp) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    if (CLOSED.includes(insp.lifecycleStatus)) return reply.code(409).send({ error: { code: 'SESSION_CLOSED', message: 'Session already closed' } });
    if (insp.lifecycleStatus === 'FINALIZING' && !terminated) return reply.code(202).send(insp);
    insp.lifecycleStatus = 'FINALIZING'; insp.closeRequestedAt = new Date().toISOString(); insp.closureMode = terminated ? 'partial' : 'full';
    emit(db, insp.id, 'inspection.finalizing', { closureMode: insp.closureMode }); saveDB(db);
    if (terminated) { await finalize(insp, true); return reply.code(200).send(insp); }
    void finalize(insp, false).catch((e: any) => { insp.finalizeError = String(e?.message || e); emit(db, insp.id, 'inspection.error', { message: insp.finalizeError }); saveDB(db); });
    return reply.code(202).send(insp);
  };
  app.post('/api/v1/inspections/:id/summary', async (req: any, reply) => {
    const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    if (!CLOSED.includes(i.lifecycleStatus)) return reply.code(409).send({ error: { code: 'NOT_CLOSED', message: 'Summary is prepared after the inspection closes' } });
    void runSummary(i); return reply.code(202).send({ ok: true, status: 'running' });
  });
  app.post('/api/v1/inspections/:id/close', close(false));
  app.post('/api/v1/inspections/:id/terminate', close(true));
  app.get('/api/v1/inspections/:id/dossier', async (req: any, reply) => { const d = db.dossiers.find((x: any) => x.sessionId === req.params.id); if (!d) return reply.code(404).send({ error: 'no dossier' }); return { ...d, html: fs.readFileSync(dossierFile(d), 'utf8') }; });
  app.get('/api/v1/inspections/:id/dossier.pdf', async (req: any, reply) => {
    const insp = getInsp(req.params.id); const d = db.dossiers.find((x: any) => x.sessionId === req.params.id);
    if (!insp || !d) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No dossier yet: end or terminate the inspection first' } });
    let file = d.pdfPath ? path.join(DATA, d.pdfPath) : null;
    if (!file || !fs.existsSync(file)) file = await buildDossierPdf(insp);   // older dossiers: build on demand
    if (!file) return reply.code(503).send({ error: { code: 'PDF_UNAVAILABLE', message: `The dossier PDF could not be generated: ${d.pdfError || 'report service unavailable'}` } });
    return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${insp.id}_dossier.pdf"`).send(fs.createReadStream(file));
  });
  app.get('/api/v1/reports', async () => ({
    reports: db.dossiers.map((d: any) => {
      const insp = db.inspections.find((i: any) => i.id === d.sessionId);
      const statuses = insp ? sessionRules(insp).filter((r: any) => r.status !== 'NOT_APPLICABLE').map((r: any) => r.status) : [];
      const c = (s: string) => statuses.filter((x: string) => x === s).length;
      return { ...d, name: insp?.name || d.sessionId, closedAt: d.at, type: d.partial ? 'Partial' : 'Full',
        findings: { pass: c('PASS'), warning: c('WARNING'), fail: c('FAIL'), insufficient: c('INSUFFICIENT_EVIDENCE'), unchecked: c('NOT_INSPECTED'), total: statuses.length } };
    }),
  }));

  // Resume work a restart interrupted: open sessions re-queue evidence that
  // was accepted but not analysed, and re-run their scan comparison.
  for (const insp of db.inspections.filter(i => !CLOSED.includes(i.lifecycleStatus))) {
    for (const ev of db.evidence.filter(e => e.sessionId === insp.id && ['queued', 'processing'].includes(e.processingStatus))) {
      if (ev.mediaType === 'pointcloud') scheduleGeometry(insp); else enqueueVisual(insp, ev);
    }
    if (insp.lifecycleStatus === 'FINALIZING') void finalize(insp, insp.closureMode === 'partial');
  }

  const webDist = path.join(root, 'src/apps/web/dist');
  if (fs.existsSync(webDist)) await app.register(fastifyStatic, { root: webDist });
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const app = await buildServer(); await app.listen({ port: PORT, host: '0.0.0.0' }); console.log(`Argus API: http://localhost:${PORT}`); }
