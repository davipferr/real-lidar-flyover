import type { DecodedPoints, DecodeTransform } from '../las/decode';

export interface DecodeRequest {
  id: number;
  url: string;
  transform: DecodeTransform;
}

export type DecodeResponse =
  | ({ id: number; ok: true; bytes: number; ms: number } & DecodedPoints)
  | { id: number; ok: false; error: string };
