import type { Bounds } from './key';

/** USGS 3DEP point clouds, reorganised as Entwine Point Tiles on AWS Open Data. Public, CORS: *. */
export const USGS_BUCKET = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/';

export interface EptDimension {
  name: string;
  type: 'signed' | 'unsigned' | 'float';
  size: number;
  scale?: number;
  offset?: number;
}

/** The parts of ept.json this app uses (https://entwine.io/en/latest/entwine-point-tile.html). */
export interface EptJson {
  bounds: Bounds;
  boundsConforming: Bounds;
  dataType: 'laszip' | 'binary' | 'zstandard';
  hierarchyType: 'json' | 'gzip';
  points: number;
  schema: EptDimension[];
  span: number;
  srs?: { authority?: string; horizontal?: string; vertical?: string; wkt?: string };
  version?: string;
}

export interface EptInfo {
  name: string;
  baseUrl: string;
  /** The octree's root cube. */
  bounds: Bounds;
  /** The tight box around the actual points. Can include outliers (noise far above the ground). */
  conforming: Bounds;
  /** Voxels per axis per node: a node holds roughly span² points on a surface. */
  span: number;
  points: number;
  hasRgb: boolean;
}

export function parseEpt(name: string, baseUrl: string, json: EptJson): EptInfo {
  if (json.dataType !== 'laszip') throw new Error(`${name}: only LAZ tiles are supported (got "${json.dataType}")`);
  if (json.hierarchyType !== 'json') throw new Error(`${name}: unsupported hierarchy type "${json.hierarchyType}"`);
  const horizontal = json.srs?.horizontal;
  if (horizontal && horizontal !== '3857') throw new Error(`${name}: expected EPSG:3857 coordinates, got EPSG:${horizontal}`);
  return {
    name,
    baseUrl,
    bounds: json.bounds,
    conforming: json.boundsConforming,
    span: json.span,
    points: json.points,
    hasRgb: json.schema.some((d) => d.name === 'Red'),
  };
}

export async function fetchEpt(name: string, signal?: AbortSignal): Promise<EptInfo> {
  const baseUrl = `${USGS_BUCKET}${encodeURIComponent(name)}/`;
  const res = await fetch(`${baseUrl}ept.json`, { signal });
  if (!res.ok) throw new Error(`${name}: ept.json returned HTTP ${res.status}`);
  return parseEpt(name, baseUrl, (await res.json()) as EptJson);
}
