import { USGS_BUCKET } from '../ept/info';
import type { ColorMode } from '../render/pointMaterial';

/**
 * Hand-picked places (Oct 2026). A dataset's bounding box is not its coverage: CA_SierraNevada_11's box
 * contains Half Dome, but its points don't. So each place was checked by walking the dataset's octree
 * hierarchy and summing the points in the cells around the focus. Where several datasets overlap, the
 * densest one won. `points` is the dataset's total.
 */
export interface Place {
  slug: string;
  title: string;
  region: string;
  dataset: string;
  lat: number;
  lon: number;
  /** Camera: compass heading it looks toward (°), angle below the horizon (°), distance to target (m). */
  heading: number;
  pitch: number;
  distance: number;
  mode: ColorMode;
  points: number;
}

export const PLACES: Place[] = [
  {
    slug: 'manhattan',
    title: 'Midtown Manhattan',
    region: 'New York City',
    dataset: 'NY_NewYorkCity',
    lat: 40.7484,
    lon: -73.9857,
    heading: 30,
    pitch: 28,
    distance: 1400,
    mode: 'classification',
    points: 4.76e9,
  },
  {
    slug: 'grand-canyon',
    title: 'Grand Canyon',
    region: 'Arizona',
    dataset: 'AZ_GrandCanyonNP_1_2019',
    lat: 36.08,
    lon: -111.98,
    heading: 340,
    pitch: 28,
    distance: 9000,
    mode: 'elevation',
    points: 22.45e9,
  },
  {
    slug: 'devils-tower',
    title: 'Devils Tower',
    region: 'Wyoming',
    dataset: 'WY_FEMA_East_B3_2019',
    lat: 44.5902,
    lon: -104.7146,
    heading: 20,
    pitch: 22,
    distance: 900,
    mode: 'elevation',
    points: 42.06e9,
  },
  {
    slug: 'golden-gate',
    title: 'Golden Gate Bridge',
    region: 'San Francisco, California',
    dataset: 'CA_SanFrancisco_1_B23',
    lat: 37.8199,
    lon: -122.4783,
    heading: 340,
    pitch: 22,
    distance: 1800,
    mode: 'classification',
    points: 13.09e9,
  },
  {
    slug: 'kilauea',
    title: 'Kīlauea Caldera',
    region: 'Hawaiʻi Island',
    dataset: 'HI_Volcano_B1_2019',
    lat: 19.4069,
    lon: -155.2834,
    heading: 200,
    pitch: 35,
    distance: 5000,
    mode: 'elevation',
    points: 52.95e9,
  },
  {
    slug: 'grand-teton',
    title: 'Grand Teton',
    region: 'Wyoming',
    dataset: 'WY_GrandTetonNP_1_D22',
    lat: 43.741,
    lon: -110.8024,
    heading: 270,
    pitch: 18,
    distance: 7000,
    mode: 'elevation',
    points: 37.26e9,
  },
  {
    slug: 'niagara',
    title: 'Niagara Falls',
    region: 'New York',
    dataset: 'NY_3County_2019',
    lat: 43.0815,
    lon: -79.073,
    heading: 200,
    pitch: 30,
    distance: 1500,
    mode: 'classification',
    points: 58.62e9,
  },
  {
    slug: 'las-vegas',
    title: 'The Strip',
    region: 'Las Vegas, Nevada',
    dataset: 'USGS_LPC_NV_LasVegas_QL1_2016_LAS_2018',
    lat: 36.1126,
    lon: -115.1767,
    heading: 0,
    pitch: 25,
    distance: 2000,
    mode: 'classification',
    points: 30.04e9,
  },
  {
    slug: 'gateway-arch',
    title: 'Gateway Arch',
    region: 'St. Louis, Missouri',
    dataset: 'USGS_LPC_MO_StLouis_2017_LAS_2018',
    lat: 38.6247,
    lon: -90.1848,
    heading: 270,
    pitch: 20,
    distance: 900,
    mode: 'classification',
    points: 6.18e9,
  },
  {
    slug: 'capitol',
    title: 'US Capitol',
    region: 'Washington, D.C.',
    dataset: 'USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015',
    lat: 38.8899,
    lon: -77.0091,
    heading: 270,
    pitch: 25,
    distance: 1500,
    mode: 'classification',
    points: 30.53e9,
  },
  {
    slug: 'seattle',
    title: 'Space Needle',
    region: 'Seattle, Washington',
    dataset: 'WA_KingCo_1_2021',
    lat: 47.6205,
    lon: -122.3493,
    heading: 160,
    pitch: 22,
    distance: 1500,
    mode: 'classification',
    points: 30.99e9,
  },
  {
    slug: 'hollywood',
    title: 'Hollywood Sign',
    region: 'Los Angeles, California',
    dataset: 'USGS_LPC_CA_LosAngeles_2016_LAS_2018',
    lat: 34.1341,
    lon: -118.3215,
    heading: 0,
    pitch: 15,
    distance: 1100,
    mode: 'elevation',
    points: 75.24e9,
  },
];

export const DEFAULT_PLACE = PLACES[0];

/** Every dataset in the bucket (about 2,300), via S3's paginated ListObjectsV2. */
export async function listDatasets(signal?: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  let token: string | null = null;
  do {
    const url = new URL(USGS_BUCKET);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('delimiter', '/');
    url.searchParams.set('max-keys', '1000');
    if (token) url.searchParams.set('continuation-token', token);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Dataset list: HTTP ${res.status}`);
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    for (const el of xml.querySelectorAll('CommonPrefixes > Prefix')) {
      const name = el.textContent?.replace(/\/$/, '');
      if (name) names.push(name);
    }
    token = xml.querySelector('NextContinuationToken')?.textContent ?? null;
  } while (token);
  return names;
}

/** "WY_YellowstoneNP_3_2020" → "WY Yellowstone NP 3 2020" for display and search. */
export function prettyName(dataset: string): string {
  return dataset
    .replace(/^USGS_LPC_/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} billion`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} thousand`;
  return String(n);
}
