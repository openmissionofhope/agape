// Builds data/us-zcta.csv (ZIP Code Tabulation Area internal points) from the
// US Census Bureau Gazetteer file, which is in the public domain.
//
//   curl -LO https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip
//   unzip 2025_Gaz_zcta_national.zip
//   node scripts/build-zcta.mjs 2025_Gaz_zcta_national.txt
//
// ZCTAs approximate, but are not identical to, USPS ZIP codes. Agape uses them
// only to place a request or a volunteer's service area approximately.
import { readFileSync, writeFileSync } from 'node:fs';

const [input] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/build-zcta.mjs <Gaz_zcta_national.txt>');
  process.exit(2);
}
const lines = readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean);
const header = lines.shift().split('|').map((h) => h.trim());
const iZip = header.indexOf('GEOID');
const iLat = header.indexOf('INTPTLAT');
const iLng = header.indexOf('INTPTLONG');
if (iZip < 0 || iLat < 0 || iLng < 0) throw new Error('unexpected Gazetteer header: ' + header.join(','));
const out = ['zip,lat,lng'];
for (const line of lines) {
  const cols = line.split('|').map((c) => c.trim());
  const zip = cols[iZip];
  const lat = Number(cols[iLat]);
  const lng = Number(cols[iLng]);
  if (!/^\d{5}$/.test(zip) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  out.push(`${zip},${lat.toFixed(4)},${lng.toFixed(4)}`);
}
writeFileSync(new URL('../data/us-zcta.csv', import.meta.url), out.join('\n') + '\n');
console.log(`wrote ${out.length - 1} ZCTAs`);
