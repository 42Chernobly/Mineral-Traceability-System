/**
 * Geography for the consignment map.
 *
 * Events store only a free-text `location` (it is part of the hash chain, so it is never altered).
 * To draw movement we resolve that text to coordinates, in this order:
 *   1. a stop (by name) that has coordinates in the database,
 *   2. this built-in gazetteer (known stops, towns on the Zambia -> Namibia / Tanzania export routes,
 *      and a representative hub per destination country).
 * A location that cannot be resolved is reported as "unmapped" rather than guessed.
 *
 * Coordinates are approximate (town / facility level) and the demo data is simulated.
 */

// key (lower case) -> [latitude, longitude, display name]
const PLACES = {
  // stops seeded with the demo data
  'solwezi copper mine': [-12.18, 26.39, 'Solwezi Copper Mine'],
  'mufulira smelter & refinery': [-12.55, 28.24, 'Mufulira Smelter & Refinery'],
  'kalumbila cobalt works': [-12.32, 25.32, 'Kalumbila Cobalt Works'],
  'chambishi copper smelter': [-12.65, 28.05, 'Chambishi Copper Smelter'],
  'copperbelt haulage depot': [-12.81, 28.2, 'Copperbelt Haulage Depot'],
  'kitwe weighbridge': [-12.79, 28.23, 'Kitwe Weighbridge'],
  'ndola inspection yard': [-12.96, 28.64, 'Ndola Inspection Yard'],
  'kasumbalesa border post': [-12.26, 27.79, 'Kasumbalesa Border Post'],
  'katima mulilo border post': [-17.495, 24.275, 'Katima Mulilo Border Post'],
  'katima mulilo weighbridge': [-17.505, 24.265, 'Katima Mulilo Weighbridge'],
  'walvis bay port': [-22.957, 14.505, 'Walvis Bay Port'],
  'dar es salaam port': [-6.818, 39.297, 'Dar es Salaam Port'],
  // towns that appear in free-text locations
  solwezi: [-12.18, 26.39, 'Solwezi'],
  mufulira: [-12.55, 28.24, 'Mufulira'],
  kalumbila: [-12.32, 25.32, 'Kalumbila'],
  chambishi: [-12.65, 28.05, 'Chambishi'],
  kitwe: [-12.8, 28.21, 'Kitwe'],
  ndola: [-12.96, 28.64, 'Ndola'],
  lusaka: [-15.39, 28.32, 'Lusaka'],
  kasumbalesa: [-12.26, 27.79, 'Kasumbalesa'],
  livingstone: [-17.84, 25.85, 'Livingstone'],
  'katima mulilo': [-17.5, 24.27, 'Katima Mulilo'],
  'walvis bay': [-22.957, 14.505, 'Walvis Bay'],
  'dar es salaam': [-6.818, 39.297, 'Dar es Salaam'],
  // destinations: one representative hub per country
  switzerland: [47.377, 8.542, 'Switzerland (Zurich)'],
  china: [22.543, 114.058, 'China (Shenzhen)'],
  singapore: [1.264, 103.82, 'Singapore'],
  'united arab emirates': [25.012, 55.061, 'United Arab Emirates (Jebel Ali)'],
  uae: [25.012, 55.061, 'United Arab Emirates (Jebel Ali)'],
  namibia: [-22.957, 14.505, 'Namibia (Walvis Bay)'],
  tanzania: [-6.818, 39.297, 'Tanzania (Dar es Salaam)'],
};

// Longest keys first so "katima mulilo border post" wins over "katima mulilo".
const KEYS = Object.keys(PLACES).sort((a, b) => b.length - a.length);

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Parses optional latitude/longitude input; returns null when both are blank, throws on bad input. */
function parseCoords(lat, lng) {
  const blank = (v) => v === undefined || v === null || String(v).trim() === '';
  if (blank(lat) && blank(lng)) return null;
  if (blank(lat) || blank(lng)) throw new Error('Enter both latitude and longitude, or leave both blank');
  const a = Number(lat); const b = Number(lng);
  if (!validCoord(a, b)) throw new Error('Latitude must be between -90 and 90 and longitude between -180 and 180');
  return { latitude: Math.round(a * 1e6) / 1e6, longitude: Math.round(b * 1e6) / 1e6 };
}

/** Coordinates for a known stop name (used to seed / backfill stops). */
function coordsForStopName(name) {
  const p = PLACES[norm(name)];
  return p ? { latitude: p[0], longitude: p[1] } : null;
}

/**
 * Returns resolve(text) -> { lat, lng, name } | null, using stops from the database first.
 * `stops` rows need name, latitude, longitude.
 */
function makeResolver(stops) {
  const byName = new Map();
  (stops || []).forEach((s) => {
    const lat = s.latitude === null || s.latitude === undefined ? NaN : Number(s.latitude);
    const lng = s.longitude === null || s.longitude === undefined ? NaN : Number(s.longitude);
    if (validCoord(lat, lng)) byName.set(norm(s.name), { lat, lng, name: s.name });
  });
  const cache = new Map();
  return function resolve(text) {
    const key = norm(text);
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    let out = byName.get(key) || null;
    if (!out) {
      for (const [n, v] of byName) { if (key.includes(n)) { out = v; break; } }
    }
    if (!out) {
      const k = KEYS.find((x) => key === x) || KEYS.find((x) => key.includes(x));
      if (k) out = { lat: PLACES[k][0], lng: PLACES[k][1], name: PLACES[k][2] };
    }
    cache.set(key, out);
    return out;
  };
}

module.exports = { PLACES, makeResolver, parseCoords, coordsForStopName, validCoord };
