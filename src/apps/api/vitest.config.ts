import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests never touch the repo's data/ working store or a running inspection
// service: data goes to a temp dir; INSPECTION_SERVICE_URL is set by the
// tests themselves to an in-process mock orchestrator.
export default defineConfig({
  test: {
    env: {
      ARGUS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'argus-api-test-')),
      INSPECTION_SERVICE_URL: 'http://127.0.0.1:9',
      CLOSE_DRAIN_TIMEOUT_MS: '5000',
      AUTO_CLOSE_MS: '-1',
    },
  },
});
