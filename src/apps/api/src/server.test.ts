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
