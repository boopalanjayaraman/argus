/**
 * Bounded analysis queue (PRD-07): decouples `202 Accepted` from inference.
 *
 * Each accepted photo/video gets one job, run while the stream continues;
 * the merged-scan comparison is one coalesced job per session that re-runs
 * when chunks arrive while it is running. Concurrency is bounded per kind
 * (visual calls are network-bound to Meta, geometry is CPU-heavy ICP).
 * Jobs can be drained with a deadline (End Inspection) or cancelled at once
 * (Terminate Now / drain timeout); a cancelled job's signal is aborted so
 * its late result is never written.
 */
export type JobKind = 'visual' | 'geometry';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  sessionId: string;
  kind: JobKind;
  evidenceId?: string;
  state: JobState;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<void>;
  rerun?: boolean;
  error?: string;
}

export class AnalysisQueue {
  private jobs = new Map<string, Job>();
  private waiters = new Set<() => void>();

  constructor(private limits: Record<JobKind, number> = { visual: 3, geometry: 1 }, private onChange: (job: Job) => void = () => {}) {}

  /** Add a job unless one with the same id is queued; a running job with
   *  the same id is marked to run once more after it finishes (coalescing). */
  enqueue(sessionId: string, id: string, kind: JobKind, run: Job['run'], evidenceId?: string): Job {
    const existing = this.jobs.get(id);
    if (existing && existing.state === 'queued') return existing;
    if (existing && existing.state === 'running') { existing.rerun = true; existing.run = run; return existing; }
    const job: Job = { id, sessionId, kind, evidenceId, state: 'queued', controller: new AbortController(), run };
    this.jobs.set(id, job);
    this.onChange(job);
    this.pump();
    return job;
  }

  private running(kind: JobKind) { return [...this.jobs.values()].filter(j => j.kind === kind && j.state === 'running').length; }

  private pump() {
    for (const job of this.jobs.values()) {
      if (job.state !== 'queued' || this.running(job.kind) >= (this.limits[job.kind] || 1)) continue;
      job.state = 'running';
      this.onChange(job);
      job.run(job.controller.signal).then(() => {
        if (job.state === 'running') job.state = 'done';
      }).catch((e: any) => {
        if (job.state === 'running') { job.state = 'failed'; job.error = String(e?.message || e); }
      }).finally(() => {
        this.onChange(job);
        if (job.rerun && job.state === 'done') {
          job.rerun = false; job.state = 'queued'; job.controller = new AbortController();
          this.onChange(job);
        }
        this.pump();
        this.notify();
      });
    }
  }

  private notify() { for (const w of [...this.waiters]) w(); }

  /** Jobs still queued or running for a session. */
  pending(sessionId: string): Job[] {
    return [...this.jobs.values()].filter(j => j.sessionId === sessionId && (j.state === 'queued' || j.state === 'running'));
  }

  jobsFor(sessionId: string): Job[] { return [...this.jobs.values()].filter(j => j.sessionId === sessionId); }

  /** Abort everything still pending for a session; returns what was cancelled. */
  cancel(sessionId: string): Job[] {
    const cancelled = this.pending(sessionId);
    for (const job of cancelled) { job.state = 'cancelled'; job.rerun = false; job.controller.abort(); this.onChange(job); }
    this.pump();
    this.notify();
    return cancelled;
  }

  /** Wait until the session's jobs finish or the deadline passes. */
  drain(sessionId: string, timeoutMs: number): Promise<{ drained: boolean; remaining: Job[] }> {
    return new Promise(resolve => {
      const check = () => {
        const remaining = this.pending(sessionId);
        if (!remaining.length) { done(); resolve({ drained: true, remaining: [] }); }
      };
      const timer = setTimeout(() => { done(); resolve({ drained: false, remaining: this.pending(sessionId) }); }, timeoutMs);
      const done = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }
}
