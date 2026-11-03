import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { buildServer, aggregateOutcome, ingestAuthorized } from './server.js';

// In-process mock of the Python orchestrator: deterministic observations so
// live analysis, cancellation and drain can be tested without Meta calls.
const mock = { delayMs: 30, calls: [] as string[] };
const orchestrator = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    mock.calls.push(req.url || '');
    const send = (o: any) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/analyze-evidence') {
      const ev = json.evidences[0];
      setTimeout(() => send({ observations: [
        { kind: 'detections', evidenceId: ev.evidenceId, model: 'sam-3.1', components: [{ id: 'nameplate', prompt: 'metal nameplate', boxes: 1, objects: [{ objectId: 0, box: { left: 1, top: 2, right: 30, bottom: 20 }, confidence: 0.9, mask: { bounds: { left: 1, top: 2, right: 30, bottom: 20 }, svgPath: 'M0 0L5 0L5 5Z' } }], width: 64, height: 48 }] },
        { ruleId: '2.7', ruleStatus: 'PASS', kind: 'component_present', certainty: 'observed', notes: 'plate fixed', model: 'muse-spark-1.3', evidenceId: ev.evidenceId },
      ] }), mock.delayMs);
    } else if (req.url === '/compare-merged') {
      send({ observation: { kind: 'geometry', mergedChunks: json.evidences.length, registration: { status: 'valid', fitness: 1, surfaceCoverageFraction: 0.95, rmsDeviationMm: 2.0, rmseMm: 2.0, p95DeviationMm: 4.1, meanDeviationMm: 1.5 },
        ruleResults: json.rules.map((r: any) => ({ ruleId: r.ruleId, ruleStatus: 'PASS' })) } });
    } else if (req.url === '/track-video') {
      mock.calls.push(`track:${json.url}`);
      send({ status: 'ready', fps: 5, width: 64, height: 48, duration: 1, model: 'sam-3.1',
        components: [{ id: 'nameplate', prompt: 'metal nameplate', objects: [{ objectId: '0', frames: [[0, 1, 2, 30, 20, 0.9], [4, 3, 2, 32, 20, 0.9]] }] },
          { id: 'flange_face', prompt: 'flange face', objects: [] }],
        componentRules: { nameplate: ['2.7', 'NP-001'], flange_face: ['4.3'] } });
    } else if (req.url === '/documents/extract') {
      // Like the real service: download the stored document first.
      fetch(json.url).then(r => r.arrayBuffer()).then(() => send({ pages: 3, orderNumber: 'WO-TEST-001', context: 'Work order WO-TEST-001 size 48 in', rules: [
        { ruleId: 'WO-R01', section: 'WO-R01', title: 'Flanges match CAD', quote: 'Both body flanges match the approved CAD.', modalities: ['photo', 'video', 'pointcloud'], applicability: 'APPROVED', origin: 'order', page: 2 },
        { ruleId: 'WO-R07', section: 'WO-R07', title: 'Test records', quote: 'Required tests have approved records.', modalities: [], applicability: 'REFERENCE_ONLY', origin: 'order', page: 2 },
      ] }));
    } else { res.writeHead(404); res.end('{}'); }
  });
});

let app: any;
beforeAll(async () => {
  await new Promise<void>(r => orchestrator.listen(0, '127.0.0.1', r));
  process.env.INSPECTION_SERVICE_URL = `http://127.0.0.1:${(orchestrator.address() as any).port}`;
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  process.env.EVIDENCE_BASE_URL = `http://127.0.0.1:${app.server.address().port}`;
});
afterAll(async () => { await app.close(); orchestrator.close(); });

const until = async (fn: () => Promise<boolean>, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 40)); } return false; };
const photoForm = (eventId: string, bytes = 'fake-png') => { const f = new FormData(); f.append('metadata', JSON.stringify({ schemaVersion: '1.0', eventId, sourceId: 'camera-photos-01', sequence: 1, relativeTimeMs: 0, mediaType: 'photo', synthetic: true })); f.append('file', new Blob([Buffer.from(bytes)], { type: 'image/png' }), `${eventId}.png`); return f; };
const newSession = async (name = 'Run') => (await app.inject({ method: 'POST', url: '/api/v1/inspections', payload: { name, model_id: 'CVS6000_VALVE' } })).json();

describe('argus api', () => {
  test('outcome aggregation', () => {
    expect(aggregateOutcome(['PASS', 'FAIL'])).toBe('FAIL');
    expect(aggregateOutcome(['PASS', 'NOT_INSPECTED'])).toBe('INCONCLUSIVE');
    expect(aggregateOutcome(['PASS', 'PASS'])).toBe('PASS');
  });
  test('ingest token gate: enforced only when configured', async () => {
    const req = (h?: string) => ({ headers: h ? { authorization: h } : {} });
    delete process.env.ARGUS_INGEST_TOKEN;
    expect(ingestAuthorized(req())).toBe(true); // local demo: unset = open
    process.env.ARGUS_INGEST_TOKEN = '<server-to-server-token>';
    expect(ingestAuthorized(req())).toBe(true); // placeholder = open
    process.env.ARGUS_INGEST_TOKEN = 's3cret-token';
    expect(ingestAuthorized(req())).toBe(false);
    expect(ingestAuthorized(req('Bearer wrong'))).toBe(false);
    expect(ingestAuthorized(req('Bearer s3cret-token'))).toBe(true);
    expect(ingestAuthorized(req('s3cret-token'))).toBe(false); // scheme required
    // HTTP level: upload without token -> 401, with token -> 202
    const c = await app.inject({ method: 'POST', url: '/api/v1/inspections', payload: { name: 'Token Run', model_id: 'CVS6000_VALVE' } });
    const insp = c.json();
    const form = new FormData();
    form.append('metadata', JSON.stringify({ schemaVersion: '1.0', eventId: 'img-tok', sourceId: 'camera-photos-01', sequence: 1, relativeTimeMs: 0, mediaType: 'photo', synthetic: true }));
    form.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), '1.png');
    const noTok = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: form });
    expect(noTok.statusCode).toBe(401);
    const form2 = new FormData();
    form2.append('metadata', JSON.stringify({ schemaVersion: '1.0', eventId: 'img-tok', sourceId: 'camera-photos-01', sequence: 1, relativeTimeMs: 0, mediaType: 'photo', synthetic: true }));
    form2.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), '1.png');
    const withTok = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, headers: { authorization: 'Bearer s3cret-token' }, payload: form2 });
    expect(withTok.statusCode).toBe(202);
    delete process.env.ARGUS_INGEST_TOKEN;
  });
  test('create session pins CAD by model_id and ingestion is idempotent', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/v1/inspections', payload: { name: 'CVS 6000D — Blue Valve Run', model_id: 'CVS6000_VALVE' } });
    expect(c.statusCode).toBe(201);
    const insp = c.json();
    expect(insp.lifecycleStatus).toBe('WAITING'); expect(insp.model_id).toBe('CVS6000_VALVE'); expect(insp.cadSha256).toBeTruthy();
    const form = new FormData();
    form.append('metadata', JSON.stringify({ schemaVersion: '1.0', eventId: 'img-0001', sourceId: 'camera-photos-01', sequence: 1, relativeTimeMs: 0, mediaType: 'photo', synthetic: true }));
    form.append('file', new Blob([Buffer.from('fake-png-bytes')], { type: 'image/png' }), '1.png');
    const up = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: form });
    expect(up.statusCode).toBe(202);
    const up2 = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: form });
    expect(up2.statusCode).toBe(202);
    const ev = await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/evidence` });
    expect(ev.json()).toHaveLength(1);
    const close = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/close` });
    expect(close.statusCode).toBe(202);
    expect(close.json().lifecycleStatus).toBe('FINALIZING');
    expect(await until(async () => (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}` })).json().lifecycleStatus === 'COMPLETED')).toBe(true);
    const late = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: form });
    expect(late.statusCode).toBe(409);
  });
});

import { samplePlyBuffer } from './server.js';
describe('samplePlyBuffer', () => {
  test('stride-samples a binary PLY and rewrites the vertex count', () => {
    const header = ['ply', 'format binary_little_endian 1.0', 'element vertex 10', 'property float x', 'property float y', 'property float z', 'end_header', ''].join('\n');
    const body = Buffer.alloc(10 * 12);
    for (let i = 0; i < 10; i++) { body.writeFloatLE(i, i * 12); }
    const out = samplePlyBuffer(Buffer.concat([Buffer.from(header), body]), 4);
    expect(out.toString('ascii', 0, 200)).toContain('element vertex 4');
    const bodyStart = out.indexOf('end_header\n') + 'end_header\n'.length;
    expect((out.length - bodyStart) / 12).toBe(4);
    expect(out.readFloatLE(bodyStart)).toBe(0);
  });
  test('returns small PLYs unchanged', () => {
    const data = Buffer.from('ply\nend_header\n');
    expect(samplePlyBuffer(data, 80000)).toBe(data);
  });
});

import { pickRegistration } from './server.js';
describe('pickRegistration', () => {
  test('picks the highest-fitness geometry registration', () => {
    const best = pickRegistration([{ registration: { fitness: 0.2, rmseMm: 9 } }, { registration: { fitness: 0.8, rmseMm: 1 } }, { kind: 'screen' }]);
    expect(best.rmseMm).toBe(1);
  });
  test('returns null without geometry observations', () => {
    expect(pickRegistration([{ kind: 'screen' }])).toBeNull();
    expect(pickRegistration([])).toBeNull();
  });
});

import { orderVideos, parseRange } from './server.js';
describe('merged video helpers', () => {
  test('orders segments by sequence then capture time', () => {
    const evs = [
      { mediaType: 'video', eventId: 'video-0003', sequence: 3, relativeTimeMs: 4000 },
      { mediaType: 'photo', eventId: 'photo-0001', sequence: 1 },
      { mediaType: 'video', eventId: 'video-0001', sequence: 1, relativeTimeMs: 0 },
      { mediaType: 'video', eventId: 'video-0002', sequence: 2, relativeTimeMs: 2000 }
    ];
    expect(orderVideos(evs).map((e: any) => e.eventId)).toEqual(['video-0001', 'video-0002', 'video-0003']);
  });
  test('parses byte ranges for seeking', () => {
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('bytes=2000-', 1000)).toBeNull();
  });
});

import { verdictFromObservation } from './server.js';
describe('verdictFromObservation', () => {
  test('applies a gate verdict with the model note', () => {
    const v = verdictFromObservation({ ruleId: '2.7', ruleStatus: 'PASS', kind: 'component_present', certainty: 'observed', notes: 'plate fixed', model: 'muse-spark-1.3', evidenceId: 'ev-photo-0001' });
    expect(v).toMatchObject({ ruleId: '2.7', status: 'PASS', evidenceId: 'ev-photo-0001' });
    expect(v!.reason).toContain('plate fixed');
  });
  test('never overwrites from unavailable or uninspected observations', () => {
    expect(verdictFromObservation({ ruleId: '2.7', ruleStatus: 'NOT_INSPECTED', status: 'unavailable' })).toBeNull();
    expect(verdictFromObservation({ ruleId: '2.7', kind: 'failed' })).toBeNull();
  });
});

import { latestStatuses } from './server.js';
describe('latestStatuses', () => {
  test('counts only the latest revision per rule', () => {
    const findings = [
      { sessionId: 's1', ruleId: '2.1', revision: 1, ruleStatus: 'INSUFFICIENT_EVIDENCE' },
      { sessionId: 's1', ruleId: '2.1', revision: 2, ruleStatus: 'INSUFFICIENT_EVIDENCE' },
      { sessionId: 's1', ruleId: '2.1', revision: 3, ruleStatus: 'PASS' },
      { sessionId: 's1', ruleId: '2.2', revision: 1, ruleStatus: 'INSUFFICIENT_EVIDENCE' },
      { sessionId: 's2', ruleId: '2.1', revision: 9, ruleStatus: 'FAIL' }
    ];
    expect(latestStatuses(findings, 's1').sort()).toEqual(['INSUFFICIENT_EVIDENCE', 'PASS']);
  });
  test('evidence-needed observations become INSUFFICIENT_EVIDENCE findings', () => {
    const v = verdictFromObservation({ ruleId: '9.5', ruleStatus: 'INSUFFICIENT_EVIDENCE', kind: 'evidence_needed', notes: 'Needs testRecord evidence beyond this photo', evidenceId: 'ev-photo-0001' });
    expect(v).toMatchObject({ ruleId: '9.5', status: 'INSUFFICIENT_EVIDENCE', evidenceId: 'ev-photo-0001' });
  });
});

import { citation } from './server.js';
describe('citation', () => {
  test('names the document once and the rule location', () => {
    expect(citation({ ruleId: '2.7', code: '2.7', section: 'Identification and Marking', source: 'ASME B16.x checklist', document: 'ASME.md' })).toBe('ASME B16.x checklist (ASME.md) · § Identification and Marking · rule 2.7');
    expect(citation({ ruleId: 'WO-R02', origin: 'order', page: 2, source: 'WO-1 (wo.pdf)', document: 'wo.pdf' })).toBe('WO-1 (wo.pdf) · p.2 · rule WO-R02');
  });
});

import { buildRuleIndex, loadRuleIndex, selectSessionRules, equipmentMatches } from './rules.js';
describe('rule index and session selection', () => {
  const swingCheck = { family: 'Valve', type: 'swing_check', end_connection: 'flanged' };
  test('committed index is up to date with sources and metadata', () => {
    const built = buildRuleIndex();
    const file = loadRuleIndex();
    expect(file.revision).toBe(built.revision);
    expect(file.rules).toEqual(built.rules);
  });
  test('rule IDs are unique join keys', () => {
    const ids = loadRuleIndex().rules.map((r: any) => r.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('equipment narrowing comes from rule text: subtype and end connection', () => {
    const rule = (id: string) => loadRuleIndex().rules.find((r: any) => r.ruleId === id);
    expect(equipmentMatches(rule('8.4'), swingCheck)).toBe(true);
    expect(equipmentMatches(rule('8.4'), { ...swingCheck, type: 'ball' })).toBe(false);
    expect(equipmentMatches(rule('5.1'), swingCheck)).toBe(false);
    expect(equipmentMatches(rule('5.1'), { ...swingCheck, end_connection: 'butt_weld' })).toBe(true);
    expect(equipmentMatches(rule('NP-004'), swingCheck)).toBe(true); // one manufacturer's rule set for the demo
  });
  test('cascade steps are real filters, and order rules add to the last step', () => {
    const index = loadRuleIndex();
    const base = selectSessionRules(index, swingCheck, null).cascade;
    expect(base.library).toBe(index.rules.length);
    expect(base.valveType).toBeLessThan(base.library);
    expect(base.customerSpec).toBeLessThan(base.valveType);
    const withOrder = selectSessionRules(index, swingCheck, { name: 'wo.pdf', orderNumber: 'WO-1', rules: [{ ruleId: 'WO-R01', modalities: ['photo'], applicability: 'APPROVED' }, { ruleId: 'WO-R07', modalities: [], applicability: 'REFERENCE_ONLY' }] }).cascade;
    expect(withOrder.customerSpec).toBe(base.customerSpec + 1);
    expect(withOrder.orderRules).toBe(1);
  });
  test('scan rules carry approved thresholds', () => {
    const geo = loadRuleIndex().rules.filter((r: any) => r.ruleId.startsWith('GEO-'));
    expect(geo.map((r: any) => r.ruleId)).toEqual(['GEO-001', 'GEO-002', 'GEO-003']);
    expect(geo.every((r: any) => r.threshold && r.approval && r.applicability === 'DEMO_ONLY' && r.modalities.includes('pointcloud'))).toBe(true);
  });
});

describe('pinned session snapshot', () => {
  test('uploading evidence alone creates no findings; counts are per applicable rule', async () => {
    mock.delayMs = 2000;
    const insp = await newSession('Counts Run');
    const rules = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/rules` })).json();
    expect(rules.snapshot.snapshotId).toBe(`ref-${insp.id}-r1`);
    const applicable = rules.rules.filter((r: any) => r.status !== 'NOT_APPLICABLE').length;
    expect(applicable).toBe(rules.cascade.customerSpec);
    expect(rules.cascade.library).toBe(loadRuleIndex().rules.length);
    const got = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}` })).json();
    expect(got.findings.total).toBe(applicable);
    expect(got.findings.unchecked).toBe(applicable);
    await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/terminate` });
    mock.delayMs = 30;
  });
  test('a library change never changes an existing session', async () => {
    const insp = await newSession('Pinned Run');
    const before = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/rules` })).json();
    const index = loadRuleIndex();
    index.rules.push({ ruleId: 'X-999', title: 'Injected', modalities: ['photo'], applicability: 'APPROVED', equipment: { family: 'Valve', types: ['*'], endConnections: ['*'] } });
    try {
      const after = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/rules` })).json();
      expect(after.rules.map((r: any) => r.ruleId)).toEqual(before.rules.map((r: any) => r.ruleId));
      const fresh = await newSession('Fresh Run');
      const freshRules = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${fresh.id}/rules` })).json();
      expect(freshRules.rules.some((r: any) => r.ruleId === 'X-999')).toBe(true);
    } finally { index.rules.pop(); }
  });
  test('documents list the pinned snapshot, downloadable, not the old demo pack', async () => {
    const insp = await newSession('Docs Run');
    const docs = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/documents` })).json().documents;
    const snap = docs.find((d: any) => d.type === 'rules');
    expect(snap.name).toBe(`rule-snapshot-${insp.id}.json`);
    expect(docs.some((d: any) => d.name === 'rules.json')).toBe(false);
    const file = await app.inject({ method: 'GET', url: snap.url });
    expect(file.statusCode).toBe(200);
    expect(JSON.parse(file.body).snapshotId).toBe(`ref-${insp.id}-r1`);
  });
});

describe('customer order document', () => {
  const orderForm = (name = 'Order Run', file = 'wo.pdf') => { const f = new FormData(); f.append('name', name); f.append('model_id', 'CVS6000_VALVE'); f.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), file); return f; };
  test('upload at creation adds the printed order rules to the snapshot', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/v1/inspections', payload: orderForm() });
    expect(c.statusCode).toBe(201);
    const rules = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${c.json().id}/rules` })).json();
    expect(rules.orderDocument.orderNumber).toBe('WO-TEST-001');
    expect(rules.snapshot.snapshotId).toBe(`ref-${c.json().id}-r1`); // fetching the file during creation pins nothing
    expect(rules.cascade.orderRules).toBe(1);
    expect(rules.rules.find((r: any) => r.ruleId === 'WO-R01').status).toBe('NOT_INSPECTED');
    expect(rules.rules.find((r: any) => r.ruleId === 'WO-R07').status).toBe('NOT_APPLICABLE');
    const docs = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${c.json().id}/documents` })).json().documents;
    const order = docs.find((d: any) => d.type === 'order');
    expect(order.name).toBe('wo.pdf');
    expect((await app.inject({ method: 'GET', url: order.url })).body).toContain('%PDF');
  });
  test('unsupported order file type is 415', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/v1/inspections', payload: orderForm('Bad', 'order.txt') });
    expect(c.statusCode).toBe(415);
  });
  test('order document can be attached while WAITING only', async () => {
    const insp = await newSession('Late Order');
    const f = new FormData(); f.append('file', new Blob([Buffer.from('%PDF')]), 'wo.pdf');
    const ok = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/order-document`, payload: f });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().snapshotId).toBe(`ref-${insp.id}-r2`);
    await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: photoForm('img-late') });
    const f2 = new FormData(); f2.append('file', new Blob([Buffer.from('%PDF')]), 'wo.pdf');
    const frozen = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/order-document`, payload: f2 });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json().error.code).toBe('SNAPSHOT_FROZEN');
  });
});

describe('live analysis and closure', () => {
  test('a photo is analysed as it arrives, before /complete', async () => {
    const insp = await newSession('Live Run');
    await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: photoForm('img-live') });
    const rule = async () => (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/rules` })).json().rules.find((r: any) => r.ruleId === '2.7');
    expect(await until(async () => (await rule()).status === 'PASS')).toBe(true);
    const obs = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/observations` })).json();
    expect(obs[0].kind).toBe('segmentation');
    expect(obs[0].payload.components[0].objects[0].mask.svgPath).toBeTruthy();
    const ev = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/evidence` })).json();
    expect(ev[0].processingStatus).toBe('done');
    expect(ev[0].detectedComponents).toEqual(['nameplate']);
  });
  test('point-cloud chunks run the merged scan comparison and decide scan rules', async () => {
    const insp = await newSession('Scan Run');
    const f = new FormData(); f.append('metadata', JSON.stringify({ schemaVersion: '1.0', eventId: 'ply-1', sourceId: 'laser-01', sequence: 1, relativeTimeMs: 0, mediaType: 'pointcloud', synthetic: true, units: 'mm', coordinateFrame: 'scanner_local' })); f.append('file', new Blob([Buffer.from('ply')]), 'chunk.ply');
    await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/pointcloud`, payload: f });
    const geo2 = async () => (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/rules` })).json().rules.find((r: any) => r.ruleId === 'GEO-002');
    expect(await until(async () => (await geo2()).status === 'PASS')).toBe(true);
    expect((await geo2()).finding.reason).toContain('rmsDeviationMm');
  });
  test('Terminate Now cancels analysis in flight; late results are never written', async () => {
    mock.delayMs = 600;
    const insp = await newSession('Terminate Run');
    await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: photoForm('img-term') });
    const t = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/terminate` });
    expect(t.json().lifecycleStatus).toBe('TERMINATED');
    expect(t.json().outcome).toBe('INCONCLUSIVE');
    await new Promise(r => setTimeout(r, 900));
    const findings = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/findings` })).json();
    expect(findings).toHaveLength(0);
    const ev = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/evidence` })).json();
    expect(ev[0].processingStatus).toBe('cancelled');
    const dossier = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/dossier` })).json();
    expect(dossier.html).toContain('Cancelled by Terminate Now');
    expect(dossier.html).not.toContain('undefined');
    mock.delayMs = 30;
  });
  test('End Inspection drains analysis in flight before freezing', async () => {
    mock.delayMs = 400;
    const insp = await newSession('Drain Run');
    await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: photoForm('img-drain') });
    const c = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/close` });
    expect(c.json().lifecycleStatus).toBe('FINALIZING');
    expect((await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: photoForm('img-after') })).statusCode).toBe(409);
    expect(await until(async () => (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}` })).json().lifecycleStatus === 'COMPLETED')).toBe(true);
    const rules = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/rules` })).json();
    expect(rules.rules.find((r: any) => r.ruleId === '2.7').status).toBe('PASS');
    const dossier = (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/dossier` })).json().html;
    expect(dossier).toContain('§ Identification and Marking · rule 2.7');
    expect(dossier).not.toContain('p.undefined');
    mock.delayMs = 30;
  });
});

describe('server-sent events', () => {
  const readSse = (id: string, lastEventId?: number) => new Promise<string>((resolve) => {
    const { port } = app.server.address();
    let data = '';
    const req = http.get({ host: '127.0.0.1', port, path: `/api/v1/inspections/${id}/events`, headers: lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {} }, res => {
      res.on('data', c => data += c);
      setTimeout(() => { req.destroy(); resolve(data); }, 250);
    });
  });
  test('resumes after Last-Event-ID without replaying earlier events', async () => {
    const insp = await newSession('SSE Run');
    await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: photoForm('img-sse') });
    const all = await readSse(insp.id);
    const ids = [...all.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
    expect(ids[0]).toBe(1);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const resumed = await readSse(insp.id, 2);
    const rids = [...resumed.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
    expect(rids.every(n => n > 2)).toBe(true);
    expect(rids[0]).toBe(3);
  });
});

import { annotationText, videoLabels } from './server.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
describe('analyzed video annotations (display only)', () => {
  test('labels are lightly worded and come from the finding note', () => {
    expect(annotationText('FAIL', 'Flange face exposed bare metal, no protector cover visible · screened by muse-spark-1.3 · review: x')).toBe('Possible issue: flange face exposed bare metal, no protector cover visible');
    expect(annotationText('WARNING', 'Plate visible but 38C/100F text not legible at this distance and the rest of a long note that goes on and on')).toMatch(/^Worth a look: plate visible but .{10,60}…$/);
  });
  test('only FAIL/WARNING findings on tracked components get a label', () => {
    const rules = [
      { ruleId: '2.7', code: '2.7', title: 'Plate fixed', status: 'FAIL', finding: { reason: 'Plate loose · screened by m' } },
      { ruleId: 'NP-001', code: 'NP-001', title: 'Plate present', status: 'PASS', finding: { reason: 'ok' } },
      { ruleId: '4.3', code: '4.3', title: 'Gasket face', status: 'WARNING', finding: { reason: 'scratch' } },
    ];
    const tracks = { components: [{ id: 'nameplate', objects: [{ objectId: '0', frames: [[0, 1, 1, 2, 2, 1]] }] }, { id: 'flange_face', objects: [] }], componentRules: { nameplate: ['2.7', 'NP-001'], flange_face: ['4.3'] } };
    expect(videoLabels(rules, tracks)).toEqual([{ componentId: 'nameplate', ruleId: '2.7', rule: '2.7', title: 'Plate fixed', status: 'FAIL', text: 'Possible issue: plate loose' }]);
  });
  test('/complete tracks the merged video; annotations are served with tracks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-vid-'));
    const clip = path.join(dir, 'seg.mp4');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
    const insp = await newSession('Video Run');
    const f = new FormData(); f.append('metadata', JSON.stringify({ schemaVersion: '1.0', eventId: 'vid-1', sourceId: 'camera-01', sequence: 1, relativeTimeMs: 0, mediaType: 'video', synthetic: true })); f.append('file', new Blob([fs.readFileSync(clip)]), 'seg.mp4');
    expect((await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/video`, payload: f })).statusCode).toBe(202);
    await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/complete` });
    const get = async () => (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}/video/annotations` })).json();
    expect(await until(async () => (await get()).status === 'ready', 15000)).toBe(true);
    const a = await get();
    expect(a.current).toBe(true);
    expect(a.fps).toBe(5);
    expect(a.components.find((c: any) => c.id === 'nameplate').objects[0].frames).toHaveLength(2);
    expect(Array.isArray(a.labels)).toBe(true);
    // tracking never holds the session in ANALYZING: once the segment's own
    // visual analysis is done, the session is ready to close
    expect(await until(async () => (await app.inject({ method: 'GET', url: `/api/v1/inspections/${insp.id}` })).json().lifecycleStatus === 'READY_TO_CLOSE', 10000)).toBe(true);
  }, 30000);
  test('re-running tracking is allowed on a session with video only', async () => {
    const insp = await newSession('No Video');
    expect((await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/track-video` })).statusCode).toBe(409);
  });
});
