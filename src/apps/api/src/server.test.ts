import { describe, test, expect, beforeAll } from 'vitest';
import { buildServer, aggregateOutcome, ingestAuthorized } from './server.js';

let app: any;
beforeAll(async () => { app = await buildServer(); });

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
    expect(close.json().lifecycleStatus).toBe('COMPLETED');
    const late = await app.inject({ method: 'POST', url: `/api/v1/inspections/${insp.id}/photos`, payload: form });
    expect(late.statusCode).toBe(409);
  });
});
