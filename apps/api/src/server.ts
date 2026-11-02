import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { storageMode, putObjectIfConfigured } from './storage.js';
import { mongoStore } from './db.js';
import { logger } from './logger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DATA = path.join(root, 'data');
const DB_FILE = path.join(DATA, 'db.json');
const PORT = Number(process.env.PORT || 8000);
fs.mkdirSync(path.join(DATA, 'evidence'), { recursive: true });

type Rule = any;
const cadModels = JSON.parse(fs.readFileSync(path.join(root, 'src/cad_models.json'), 'utf8')).cad_models;
const rulePack = JSON.parse(fs.readFileSync(path.join(root, 'reference-data/cvs6000d-48-demo/rules/rules.json'), 'utf8'));

interface DB { inspections: any[]; evidence: any[]; findings: any[]; events: any[]; dossiers: any[] }
function loadDB(): DB { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { inspections: [], evidence: [], findings: [], events: [], dossiers: [] }; } }
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
function emit(db: DB, sessionId: string, type: string, payload: any = {}) {
  const ev = { eventSeq: db.events.filter(e => e.sessionId === sessionId).length + 1, sessionId, type, at: new Date().toISOString(), ...payload };
  db.events.push(ev); saveDB(db);
  (listeners.get(sessionId) || new Set()).forEach((res: any) => { try { res.write(`id: ${ev.eventSeq}\ndata: ${JSON.stringify(ev)}\n\n`); } catch {} });
  return ev;
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
function sessionRules(insp: any) {
  return rulePack.rules.map((r: Rule) => {
    const f = db.findings.filter((x: any) => x.sessionId === insp.id && x.ruleId === r.ruleId).sort((a: any, b: any) => b.revision - a.revision)[0];
    return { ...r, status: f ? f.ruleStatus : (r.applicability === 'REFERENCE_ONLY' ? 'NOT_APPLICABLE' : 'NOT_INSPECTED'), finding: f || null };
  });
}
function refresh(insp: any) {
  const ev = db.evidence.filter((e: any) => e.sessionId === insp.id);
  if (insp.lifecycleStatus === 'WAITING' && ev.length) insp.lifecycleStatus = 'RECEIVING';
  insp.outcome = ['COMPLETED', 'TERMINATED'].includes(insp.lifecycleStatus) ? insp.outcome : aggregateOutcome(sessionRules(insp).map((r: any) => r.status));
  insp.counts = { evidence: ev.length, video: ev.filter((e: any) => e.mediaType === 'video').length, photo: ev.filter((e: any) => e.mediaType === 'photo').length, pointcloud: ev.filter((e: any) => e.mediaType === 'pointcloud').length };
}
function analyze(insp: any, ev: any) {
  // Coordinator (mirrors services/inspection/coordinator.py gate): evidence receipt alone
  // creates ANALYZING then INSUFFICIENT_EVIDENCE unless qualified observations exist.
  for (const r of rulePack.rules) {
    if (r.applicability === 'REFERENCE_ONLY' || !r.modalities?.includes(ev.mediaType)) continue;
    const rev = db.findings.filter((f: any) => f.sessionId === insp.id && f.ruleId === r.ruleId).length + 1;
    db.findings.push({ findingId: `f-${insp.id}-${r.ruleId}`, revision: rev, sessionId: insp.id, ruleId: r.ruleId, ruleStatus: 'INSUFFICIENT_EVIDENCE', featureId: r.features?.[0] ?? null, evidenceIds: [ev.evidenceId], observationIds: [], reason: `Evidence ${ev.eventId} received; qualified observation pending (no validated registration/model observation yet)`, cadAnchor: null, at: new Date().toISOString() });
    emit(db, insp.id, 'finding.created', { ruleId: r.ruleId, evidenceId: ev.evidenceId });
  }
}
function dossierHtml(insp: any, partial: boolean) {
  const rules = sessionRules(insp);
  const rows = rules.map((r: any) => `<tr><td>${r.ruleId}</td><td>${r.title}</td><td>${r.status}</td><td>${r.quote} (${r.source} p.${r.page})</td></tr>`).join('');
  return `<!doctype html><title>Dossier ${insp.id}</title><h1>${insp.name}</h1><p>${insp.id} · ${partial ? 'Partial (terminated)' : 'Full'} · Outcome: ${insp.outcome} · Lifecycle: ${insp.lifecycleStatus}</p><p>CAD: ${insp.model_id} rev ${insp.cadRevision} sha256 ${insp.cadSha256}</p><table border="1" cellspacing="0" cellpadding="6"><tr><th>Rule</th><th>Title</th><th>Status</th><th>Pinned citation</th></tr>${rows}</table><p>Evidence: ${JSON.stringify(insp.counts)} · Human review required. Not a certification.</p>`;
}

export async function buildServer() {
  await logger.init();
  logger.info('argus api starting', { cloudLogging: logger.cloudEnabled });
  if (process.env.MONGODB_URI) {
    try {
      await mongoStore.connect();
      const fromMongo = await mongoStore.loadState();
      if (fromMongo) { db = fromMongo as DB; fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
      console.log('[argus] MongoDB connected; collections synced');
    } catch (e: any) { console.error('[argus] MongoDB connect failed, using local store:', e?.message || e); }
  }
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });
  app.get('/api/v1/health', async () => ({ ok: true, storage: storageMode }));
  app.get('/api/v1/cad-models', async () => ({ cad_models: cadModels }));
  app.get('/api/v1/instruction-sets', async () => ({ packId: rulePack.packId, rules: rulePack.rules, counts: { total: rulePack.rules.length } }));

  app.post('/api/v1/inspections', async (req: any, reply) => {
    const body = req.body || {};
    const name = (body.name || '').trim();
    const model = cadModels.find((m: any) => m.model_id === body.model_id) || cadModels[0];
    if (!name) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Inspection name is required' } });
    if (body.model_id && !model) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Unknown model_id' } });
    const insp: any = { id: `insp-${Date.now().toString(36)}`, name, model_id: model.model_id, cadRevision: model.revision, cadSha256: model.sha256, lifecycleStatus: 'WAITING', outcome: 'PENDING', createdAt: new Date().toISOString(), counts: { evidence: 0, video: 0, photo: 0, pointcloud: 0 }, producerComplete: false };
    db.inspections.push(insp); emit(db, insp.id, 'inspection.created', {}); saveDB(db);
    logger.info('inspection.created', { sessionId: insp.id, model_id: insp.model_id });
    return reply.code(201).send(insp);
  });
  app.get('/api/v1/inspections', async (req: any) => {
    const q = (req.query.q || '').toLowerCase();
    const list = db.inspections.filter((i: any) => !q || i.name.toLowerCase().includes(q) || i.id.includes(q)).slice().reverse();
    list.forEach(refresh);
    return { inspections: list, counts: { total: list.length, active: list.filter((i: any) => !['COMPLETED', 'TERMINATED'].includes(i.lifecycleStatus)).length, completed: list.filter((i: any) => i.lifecycleStatus === 'COMPLETED').length, terminated: list.filter((i: any) => i.lifecycleStatus === 'TERMINATED').length } };
  });
  const getInsp = (id: string) => db.inspections.find((i: any) => i.id === id);
  app.get('/api/v1/inspections/:id', async (req: any, reply) => { const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } }); refresh(i); return i; });
  app.get('/api/v1/inspections/:id/rules', async (req: any, reply) => { const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: 'not found' }); return { cascade: { library: rulePack.rules.length, valveType: rulePack.rules.filter((r: any) => r.applicability !== 'REFERENCE_ONLY').length, customerSpec: rulePack.rules.filter((r: any) => r.applicability === 'APPROVED').length }, rules: sessionRules(i), why: `Selected by model_id ${i.model_id} from pinned pack ${rulePack.packId}; customer spec overrides disclosed in session snapshot.` }; });
  app.get('/api/v1/inspections/:id/evidence', async (req: any) => db.evidence.filter((e: any) => e.sessionId === req.params.id));
  app.get('/api/v1/inspections/:id/findings', async (req: any) => db.findings.filter((f: any) => f.sessionId === req.params.id));
  app.get('/api/v1/inspections/:id/documents', async (req: any) => { const ev = db.evidence.filter((e: any) => e.sessionId === req.params.id); const dos = db.dossiers.filter((d: any) => d.sessionId === req.params.id); return { documents: [...ev.map((e: any) => ({ name: e.filename, type: e.mediaType, size: e.size, source: e.sourceId, at: e.at })), ...dos.map((d: any) => ({ name: `dossier-${d.sessionId}.html`, type: 'Report', size: d.size, source: 'argus', at: d.at }))], total: ev.length + dos.length }; });
  app.get('/api/v1/inspections/:id/events', async (req: any, reply) => {
    const id = req.params.id; reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (!listeners.has(id)) listeners.set(id, new Set()); listeners.get(id)!.add(reply.raw);
    db.events.filter((e: any) => e.sessionId === id).forEach((e: any) => reply.raw.write(`id: ${e.eventSeq}\ndata: ${JSON.stringify(e)}\n\n`));
    req.raw.on('close', () => listeners.get(id)?.delete(reply.raw));
  });

  const upload = (mediaType: string) => async (req: any, reply: any) => {
    const insp = getInsp(req.params.id);
    if (!insp) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    if (['COMPLETED', 'TERMINATED', 'FINALIZING'].includes(insp.lifecycleStatus)) return reply.code(409).send({ error: { code: 'SESSION_CLOSED', message: 'Session closed' } });
    let metadata: any = {}, filename = 'file', buf: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'metadata') { const v: any = (part as any).value; try { metadata = typeof v === 'string' ? JSON.parse(v) : (Buffer.isBuffer(v) ? JSON.parse(v.toString()) : v); } catch { return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Bad metadata JSON' } }); } }
      if (part.type === 'file') { filename = part.filename; buf = await part.toBuffer(); }
    }
    if (!buf) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'file required' } });
    if (mediaType === 'pointcloud' && (!metadata.units || !metadata.coordinateFrame)) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'pointcloud requires units and coordinateFrame' } });
    if (!metadata.eventId) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'eventId required' } });
    const existing = db.evidence.find((e: any) => e.sessionId === insp.id && e.eventId === metadata.eventId);
    if (existing) {
      if (existing.sha256 !== crypto.createHash('sha256').update(buf).digest('hex')) return reply.code(409).send({ error: { code: 'CONFLICT', message: 'eventId reused with different payload' } });
      return reply.code(202).send({ evidenceId: existing.evidenceId, accepted: true, processingStatus: 'queued' });
    }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const dir = path.join(DATA, 'evidence', insp.id); fs.mkdirSync(dir, { recursive: true });
    const evidenceId = `ev-${metadata.eventId}`;
    fs.writeFileSync(path.join(dir, `${evidenceId}-${filename}`), buf);
    await putObjectIfConfigured(`evidence/${insp.id}/${evidenceId}-${filename}`, buf).catch(() => null);
    const ev = { evidenceId, sessionId: insp.id, eventId: metadata.eventId, sourceId: metadata.sourceId, sequence: metadata.sequence, relativeTimeMs: metadata.relativeTimeMs, mediaType, synthetic: !!metadata.synthetic, units: metadata.units, coordinateFrame: metadata.coordinateFrame, filename, size: buf.length, sha256, at: new Date().toISOString(), processingStatus: 'queued' };
    db.evidence.push(ev); emit(db, insp.id, 'evidence.received', { evidenceId, mediaType }); analyze(insp, ev); refresh(insp); saveDB(db);
    logger.info('evidence.received', { sessionId: insp.id, evidenceId, mediaType, eventId: metadata.eventId, size: buf.length });
    return reply.code(202).send({ evidenceId, accepted: true, processingStatus: 'queued' });
  };
  app.post('/api/v1/inspections/:id/video', upload('video'));
  app.post('/api/v1/inspections/:id/photos', upload('photo'));
  app.post('/api/v1/inspections/:id/pointcloud', upload('pointcloud'));
  app.post('/api/v1/inspections/:id/complete', async (req: any, reply) => { const i = getInsp(req.params.id); if (!i) return reply.code(404).send({ error: 'not found' }); i.producerComplete = true; if (i.lifecycleStatus === 'RECEIVING') i.lifecycleStatus = 'READY_TO_CLOSE'; emit(db, i.id, 'source.complete', {}); saveDB(db); return { ok: true, sessionOpen: true }; });
  const close = (terminated: boolean) => async (req: any, reply: any) => {
    const insp = getInsp(req.params.id); if (!insp) return reply.code(404).send({ error: 'not found' });
    insp.lifecycleStatus = terminated ? 'TERMINATED' : 'COMPLETED'; insp.closedAt = new Date().toISOString();
    insp.outcome = aggregateOutcome(sessionRules(insp).map((r: any) => r.status), terminated);
    const html = dossierHtml(insp, terminated); const dir = path.join(DATA, 'dossiers'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${insp.id}.html`), html);
    db.dossiers.push({ sessionId: insp.id, partial: terminated, outcome: insp.outcome, size: html.length, at: insp.closedAt, htmlPath: `data/dossiers/${insp.id}.html` });
    emit(db, insp.id, 'inspection.closed', {}); emit(db, insp.id, 'dossier.ready', {}); saveDB(db); return insp;
  };
  app.post('/api/v1/inspections/:id/close', close(false));
  app.post('/api/v1/inspections/:id/terminate', close(true));
  app.get('/api/v1/inspections/:id/dossier', async (req: any, reply) => { const d = db.dossiers.find((x: any) => x.sessionId === req.params.id); if (!d) return reply.code(404).send({ error: 'no dossier' }); return { ...d, html: fs.readFileSync(path.join(root, d.htmlPath), 'utf8') }; });
  app.get('/api/v1/reports', async () => ({ reports: db.dossiers }));
  const webDist = path.join(root, 'apps/web/dist');
  if (fs.existsSync(webDist)) await app.register(fastifyStatic, { root: webDist });
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const app = await buildServer(); await app.listen({ port: PORT, host: '0.0.0.0' }); console.log(`Argus API: http://localhost:${PORT}`); }
