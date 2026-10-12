import type { DecodeTransform } from '../las/decode';
import type { DecodeRequest, DecodeResponse } from './protocol';

type Success = Extract<DecodeResponse, { ok: true }>;

interface Slot {
  worker: Worker;
  inFlight: number;
}

/**
 * A few decode workers. Each runs up to `perWorker` jobs at once so downloads overlap with decoding.
 * The caller pulls: it asks `hasCapacity()` and submits its highest-priority node, so priorities
 * are always decided with the latest camera, never from a stale queue.
 */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly jobs = new Map<number, { slot: Slot; resolve: (r: Success) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(
    size: number,
    private readonly perWorker = 2,
  ) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, inFlight: 0 };
      worker.onmessage = (e: MessageEvent<DecodeResponse>) => this.onMessage(e.data);
      worker.onerror = (e) => console.error('Decode worker error', e.message);
      this.slots.push(slot);
    }
  }

  get inFlight(): number {
    return this.jobs.size;
  }

  hasCapacity(): boolean {
    return this.jobs.size < this.slots.length * this.perWorker;
  }

  decode(url: string, transform: DecodeTransform): Promise<Success> {
    const slot = this.slots.reduce((a, b) => (b.inFlight < a.inFlight ? b : a));
    const id = this.nextId++;
    slot.inFlight++;
    return new Promise<Success>((resolve, reject) => {
      this.jobs.set(id, { slot, resolve, reject });
      const req: DecodeRequest = { id, url, transform };
      slot.worker.postMessage(req);
    });
  }

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    for (const job of this.jobs.values()) job.reject(new Error('Pool disposed'));
    this.jobs.clear();
  }

  private onMessage(msg: DecodeResponse): void {
    const job = this.jobs.get(msg.id);
    if (!job) return;
    this.jobs.delete(msg.id);
    job.slot.inFlight--;
    if (msg.ok) job.resolve(msg);
    else job.reject(new Error(msg.error));
  }
}
