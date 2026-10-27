// Copies the Leaflet build (used only by the optional map) into public/vendor,
// so the map loads no third-party scripts.
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const leafletDist = join(dirname(require.resolve('leaflet/package.json')), 'dist');
const target = new URL('../public/vendor/leaflet/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const file of ['leaflet.js', 'leaflet.css']) cpSync(join(leafletDist, file), new URL(file, target));
cpSync(join(leafletDist, 'images'), new URL('images', target), { recursive: true });
