// File: lib/betfair.v2.js
// Hardened Betfair REST client with minimal/fallback bodies + debug
// - Adds listEventTypes() sanity check
// - Adds listMarketBookSafe(): retries with minimal body if 400 DSC-0008
// - Uses second-precision ISO (no millis) for TimeRange
//
// ENV required:
//   BETFAIR_APP_KEY, BETFAIR_SESSION_TOKEN
// Optional:
//   DEBUG=true

const https = require('https');

const API_HOST = 'api.betfair.com';
const API_BASE = '/exchange/betting/rest/v1.0';
const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');

function isoNoMillis(d){
  const s = (d instanceof Date ? d : new Date(d)).toISOString();
  return s.replace(/\.[0-9]{3}Z$/, 'Z');
}

function requestJson(path, body) {
  const appKey = process.env.BETFAIR_APP_KEY;
  const session = process.env.BETFAIR_SESSION_TOKEN;
  if (!appKey || !session) throw new Error('Missing BETFAIR_APP_KEY or BETFAIR_SESSION_TOKEN');

  const payload = JSON.stringify(body || {});
  if (DEBUG) {
    console.log(`[betfair] POST ${API_BASE}${path}`);
    try { console.log('[betfair] body', JSON.stringify(JSON.parse(payload))); } catch { console.log('[betfair] body <unserialisable>'); }
  }

  const opts = {
    hostname: API_HOST,
    path: `${API_BASE}${path}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Application': appKey,
      'X-Authentication': session,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Betfair ${res.statusCode}: ${data}`));
        }
        try { resolve(JSON.parse(data || 'null')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Betting API wrappers ---------------------------------------------------
async function listMarketCatalogue(filter, maxResults = 200, marketProjection = ['EVENT','RUNNER_DESCRIPTION']) {
  const body = { filter, maxResults, marketProjection };
  return requestJson('/listMarketCatalogue/', body);
}

async function listMarketBookRaw(body){
  return requestJson('/listMarketBook/', body);
}

async function listMarketBook(marketIds, opts = {}) {
  if (!marketIds || marketIds.length === 0) return [];
  const body = {
    marketIds,
    priceProjection: opts.withPrices ? {
      priceData: ['EX_BEST_OFFERS'],
      virtualise: true,
      exBestOffersOverrides: { bestPricesDepth: 1 }
    } : undefined,
    orderProjection: 'NONE',
    matchProjection: 'NO_ROLLUP'
  };
  return listMarketBookRaw(body);
}

// Safer variant: try minimal body first, then progressively add fields
async function listMarketBookSafe(marketIds){
  if (!marketIds || marketIds.length === 0) return [];
  // Minimal (documented) shape
  let body = { marketIds, priceProjection: { priceData: ['EX_BEST_OFFERS'] } };
  try { return await listMarketBookRaw(body); } catch (e1){
    if (DEBUG) console.log('[listMarketBookSafe:minimal] err', e1.message);
  }
  // Next: add virtualise
  body = { marketIds, priceProjection: { priceData: ['EX_BEST_OFFERS'], virtualise:true } };
  try { return await listMarketBookRaw(body); } catch (e2){
    if (DEBUG) console.log('[listMarketBookSafe:virt] err', e2.message);
  }
  // Last: add overrides depth=1
  body = { marketIds, priceProjection: { priceData: ['EX_BEST_OFFERS'], virtualise:true, exBestOffersOverrides:{ bestPricesDepth:1 } } };
  return listMarketBookRaw(body); // bubble any error
}

// --- Helpers ---------------------------------------------------------------
function midFromBestOffers(ex) {
  if (!ex) return null;
  const bb = ex.availableToBack && ex.availableToBack[0];
  const bl = ex.availableToLay  && ex.availableToLay[0];
  if (!bb || !bl) return null;
  const back = Number(bb.price), lay = Number(bl.price);
  if (!back || !lay) return null;
  const mid = (back + lay) / 2;
  const spreadPct = ((lay - back) / mid) * 100;
  const liq = Number(bb.size || 0) + Number(bl.size || 0);
  return { mid, back, lay, spreadPct, liq };
}

const SOCCER_EVENT_TYPE_ID = '1';
function timeWindowFilter(hoursAhead = 72) {
  const from = new Date();
  const to = new Date(Date.now() + hoursAhead * 3600 * 1000);
  return { from: isoNoMillis(from), to: isoNoMillis(to) };
}

async function listEventTypes(){
  return requestJson('/listEventTypes/', { filter: {} });
}

module.exports = {
  requestJson,
  listMarketCatalogue,
  listMarketBook,
  listMarketBookSafe,
  listEventTypes,
  midFromBestOffers,
  timeWindowFilter,
  SOCCER_EVENT_TYPE_ID,
};