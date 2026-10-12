/// <reference lib="webworker" />
import createLazPerf from 'laz-perf/lib/worker/laz-perf.js';
import wasmUrl from 'laz-perf/lib/worker/laz-perf.wasm?url';

import { decodeLaz } from '../las/decode';
import type { DecodeRequest, DecodeResponse } from './protocol';

/**
 * Download + LAZ decompression off the main thread. Fetches run concurrently; decoding is
 * synchronous WASM, so one worker decodes one tile at a time while its other downloads continue.
 */

declare const self: DedicatedWorkerGlobalScope;

const lazPerf = createLazPerf({ locateFile: () => wasmUrl });

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, url, transform } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const t0 = performance.now();
    const points = decodeLaz(await lazPerf, buf, transform);
    const msg: DecodeResponse = { id, ok: true, bytes: buf.byteLength, ms: performance.now() - t0, ...points };
    const transfer: Transferable[] = [points.positions.buffer, points.intensity.buffer, points.classification.buffer];
    if (points.rgb) transfer.push(points.rgb.buffer);
    self.postMessage(msg, transfer);
  } catch (err) {
    const msg: DecodeResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(msg);
  }
};
