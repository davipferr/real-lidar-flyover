/**
 * The EPT hierarchy: which octree nodes exist and how many points each holds.
 *
 * It is split into files so a viewer never has to download the whole tree. ept-hierarchy/0-0-0-0.json
 * lists the top few levels; an entry whose count is −1 means "this node exists, but its count and
 * everything below it live in ept-hierarchy/<key>.json". Those files are fetched only when the camera
 * gets close enough to need that branch.
 */

/** −1 = node exists, its subtree file has not been loaded yet. */
export const SUBTREE = -1;

export type HierarchyJson = Record<string, number>;

export class Hierarchy {
  readonly counts = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();
  /** key → [time of last failure, consecutive failures] */
  private readonly failed = new Map<string, [number, number]>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchJson: (url: string) => Promise<HierarchyJson> = defaultFetch,
  ) {}

  /** Number of points, SUBTREE if unknown yet, or undefined if the node does not exist. */
  count(key: string): number | undefined {
    return this.counts.get(key);
  }

  has(key: string): boolean {
    return this.counts.has(key);
  }

  isLoading(key: string): boolean {
    return this.pending.has(key);
  }

  merge(json: HierarchyJson): void {
    for (const [key, n] of Object.entries(json)) {
      // A subtree file repeats its own root with the real count, replacing the −1 placeholder.
      const old = this.counts.get(key);
      if (old === undefined || old === SUBTREE) this.counts.set(key, n);
    }
  }

  /** Fetches a hierarchy file once; repeated calls share the same promise. Failures back off 2 s, 4 s, 8 s… */
  load(key: string): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const [failedAt, failures] = this.failed.get(key) ?? [0, 0];
    if (failures > 0 && performance.now() - failedAt < Math.min(60_000, 2000 * 2 ** (failures - 1))) return Promise.resolve();
    const p = this.fetchJson(`${this.baseUrl}ept-hierarchy/${key}.json`)
      .then((json) => {
        this.merge(json);
        this.failed.delete(key);
      })
      .catch((err) => {
        this.failed.set(key, [performance.now(), failures + 1]);
        console.warn(`Hierarchy ${key} failed`, err);
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }
}

async function defaultFetch(url: string): Promise<HierarchyJson> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as HierarchyJson;
}
