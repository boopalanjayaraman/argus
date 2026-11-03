/**
 * Storage configuration (G-01). Mode is chosen from env (see .env.template):
 * - GCS_BUCKET set       -> evidence bytes also go to Google Cloud Storage
 * - MONGODB_URI set      -> reported as mongo-configured (DB adapter migration
 *                           tracked in docs/notes-2026-11-02-cycle-1.md)
 * - neither              -> local files under data/ (development default)
 * Credentials are server-side only and never reach the web bundle.
 */
export const storageMode = {
  gcs: Boolean(process.env.GCS_BUCKET),
  mongo: Boolean(process.env.MONGODB_URI),
  bucket: process.env.GCS_BUCKET || null,
};

export async function putObjectIfConfigured(key: string, bytes: Buffer): Promise<string | null> {
  if (!process.env.GCS_BUCKET) return null;
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage();
  await storage.bucket(process.env.GCS_BUCKET).file(key).save(bytes);
  return `gs://${process.env.GCS_BUCKET}/${key}`;
}
