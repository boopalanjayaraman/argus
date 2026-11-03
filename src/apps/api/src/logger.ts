/**
 * Google Cloud Logging integration.
 * Enabled when GCP_PROJECT_ID is set (see .env.example); GOOGLE_APPLICATION_
 * CREDENTIALS (or workload identity / ADC on GCP) authorises writes.
 * Until then, logs go to stdout as structured JSON lines so local Docker /
 * dev runs keep the same shape. Levels: LOG_LEVEL=debug|info|warn|error.
 * Every entry carries service + sessionId/evidenceId when supplied, so one
 * inspection can be traced across api/orchestrator/agent logs in Cloud
 * Logging (same labels on the Python side in cloud_logging.py).
 */
const PROJECT = process.env.GCP_PROJECT_ID || '';
const LOG_NAME = process.env.GCP_LOG_NAME || 'argus';
const SERVICE = process.env.SERVICE_NAME || 'argus-api';
const LEVEL = process.env.LOG_LEVEL || 'info';
const ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const minLevel = ORDER[(LEVEL as keyof typeof ORDER)] ?? 20;

let gclLog: any = null;
let gclReady: Promise<void> | null = null;

function initGcl() {
  // GCP_PROJECT_ID alone is not authorisation: without credentials (key file
  // or Cloud Run/GKE workload identity) the gRPC client crashes the process
  // asynchronously. Only enable Cloud Logging when an auth path exists.
  const hasAuthPath = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE || process.env.GAE_ENV);
  if (!PROJECT || !hasAuthPath || gclReady) {
    if (PROJECT && !hasAuthPath) console.log(JSON.stringify({ severity: 'WARNING', message: 'GCP_PROJECT_ID set but no credentials path (GOOGLE_APPLICATION_CREDENTIALS or workload identity); logging to stdout', service: SERVICE }));
    return gclReady;
  }
  gclReady = (async () => {
    try {
      const { Logging } = await import('@google-cloud/logging');
      const logging = new Logging({ projectId: PROJECT });
      gclLog = logging.log(LOG_NAME);
    } catch (e) {
      console.error('[argus] Cloud Logging init failed, falling back to stdout:', (e as Error)?.message || e);
      gclLog = null;
    }
  })();
  return gclReady;
}

type Fields = Record<string, unknown>;

function emit(severity: keyof typeof ORDER, message: string, fields: Fields = {}) {
  if (ORDER[severity] < minLevel) return;
  const entry = { severity: severity.toUpperCase(), message, service: SERVICE, ...fields, time: new Date().toISOString() };
  if (PROJECT && gclLog) {
    const meta = { severity: severity.toUpperCase(), resource: { type: 'global' }, labels: { service: SERVICE, ...(fields.sessionId ? { sessionId: String(fields.sessionId) } : {}) } };
    gclLog.write(gclLog.entry(meta, entry)).catch(() => { console.log(JSON.stringify(entry)); });
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  get cloudEnabled() { return Boolean(PROJECT && (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE || process.env.GAE_ENV)); },
  async init() { await initGcl(); if (PROJECT) emit('info', 'cloud logging enabled', { project: PROJECT, logName: LOG_NAME }); },
  debug: (m: string, f?: Fields) => emit('debug', m, f),
  info: (m: string, f?: Fields) => emit('info', m, f),
  warn: (m: string, f?: Fields) => emit('warn', m, f),
  error: (m: string, f?: Fields) => emit('error', m, f),
};
