import { describe, test, expect, beforeAll } from 'vitest';
import { buildServer, aggregateOutcome } from './server.js';

let app: any;
beforeAll(async () => { app = await buildServer(); });

describe('argus api', () => {
  test('outcome aggregation', () => {
    expect(aggregateOutcome(['PASS', 'FAIL'])).toBe('FAIL');
    expect(aggregateOutcome(['PASS', 'NOT_INSPECTED'])).toBe('INCONCLUSIVE');
    expect(aggregateOutcome(['PASS', 'PASS'])).toBe('PASS');
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
