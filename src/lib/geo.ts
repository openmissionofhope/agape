const EARTH_RADIUS_M = 6_371_000;
export const METERS_PER_MILE = 1609.344;

export interface LatLng {
  lat: number;
  lng: number;
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Snaps a point to the centre of a 0.01-degree grid cell (about 1.1 km north-south).
 * Every point in a cell maps to the same public coordinate.
 */
export function coarsen(p: LatLng): LatLng {
  const snap = (v: number) => Math.floor(v * 100) / 100 + 0.005;
  return { lat: Number(snap(p.lat).toFixed(3)), lng: Number(snap(p.lng).toFixed(3)) };
}

/** Bounding box for a radius, used to pre-filter with the discovery index. */
export function boundingBox(center: LatLng, radiusM: number) {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = dLat / Math.max(0.01, Math.cos((center.lat * Math.PI) / 180));
  return { minLat: center.lat - dLat, maxLat: center.lat + dLat, minLng: center.lng - dLng, maxLng: center.lng + dLng };
}

/** Coarse, honest distance wording. Exact distances are never shown for approximate locations. */
export function distanceBand(meters: number): string {
  const miles = meters / METERS_PER_MILE;
  if (miles < 2) return 'within about 2 miles';
  if (miles < 5) return 'about 2–5 miles away';
  if (miles < 10) return 'about 5–10 miles away';
  if (miles < 25) return 'about 10–25 miles away';
  if (miles < 60) return 'about 25–60 miles away';
  return 'more than 60 miles away';
}

export function milesToMeters(mi: number): number {
  return Math.round(mi * METERS_PER_MILE);
}

export function metersToMiles(m: number): number {
  return Math.round(m / METERS_PER_MILE);
}
