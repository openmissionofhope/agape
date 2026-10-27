import { readFileSync } from 'node:fs';
import type { LatLng } from './geo.js';

let table: Map<string, LatLng> | null = null;

function load(): Map<string, LatLng> {
  if (table) return table;
  const file = new URL('../../data/us-zcta.csv', import.meta.url);
  const rows = readFileSync(file, 'utf8').split('\n');
  table = new Map();
  for (const row of rows.slice(1)) {
    const [zip, lat, lng] = row.split(',');
    if (zip && lat && lng) table.set(zip, { lat: Number(lat), lng: Number(lng) });
  }
  return table;
}

/** Approximate point for a US ZIP code (Census ZCTA internal point), or null if unknown. */
export function zipToPoint(zip: string): LatLng | null {
  const z = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  return load().get(z) ?? null;
}
