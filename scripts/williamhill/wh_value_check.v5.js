// File: scripts/williamhill/wh_value_check.v5.js
// WH snapshot → parse → Betfair map → fair odds → value filter → Bet Tracker
// v5.1 updates:
//  • Added PSG alias “Paris St-G” (+ “Paris St G”) and improved normaliser (saint↔st)
//  • Runner matching checks against *all* alias queries (dump + built‑ins)
//  • MATCH_ODDS fallback (search-all then filter by name) retained
//  • Default max spread = 20%
//  • Guard against missing marketStartTime (fixes “Invalid time value”)
//
// CLI
//   node scripts/williamhill/wh_value_check.v5.js run --file="./scripts/williamhill/snapshots/<file>.html" [--url="https://..."] [--threshold=1.05] [--minliq=50] [--maxspread=20]
//
const fsp = require('fs/promises');
const path = require('path');
const { parseWilliamHillHTML } = require('./williamhill_prototype.v4');
const { appendToBetTrackerRow } = require('../../lib/sheets.bettracker');
const { listMarketCatalogue, listMarketBookSafe, midFromBestOffers, timeWindowFilter, SOCCER_EVENT_TYPE_ID } = require('../../lib/betfair.v2');

const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');
const DRY_RUN = /^true$/i.test(process.env.DRY_RUN || 'false');

function norm(s){
  return (s||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // strip accents
    .toLowerCase()
    .replace(/\bsaint\b/g,'st')
    .replace(/\bst\.?\b/g,'st')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\b(fc|afc|cf)\b/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
function sameTeam(a,b){ return a && b && norm(a)===norm(b); }
function ddmmyyyy(d){ const dt=(d instanceof Date)?d:new Date(d); const p=n=>String(n).padStart(2,'0'); return `${p(dt.getDate())}/${p(dt.getMonth()+1)}/${dt.getFullYear()}`; }

// ---- Alias inventory (from dump script) -----------------------------------
let ALIAS_INDEX = null; // Map<normalised_label, Set<label>>
async function loadAliasIndex(){
  if (ALIAS_INDEX) return ALIAS_INDEX;
  const candidates = [
    path.resolve(__dirname, '../../data/soccer_teams.json'),
    path.resolve(process.cwd(), 'data/soccer_teams.json'),
  ];
  for (const p of candidates){
    try {
      const raw = await fsp.readFile(p, 'utf8');
      const j = JSON.parse(raw);
      const idx = new Map();
      const teams = Array.isArray(j.teams) ? j.teams : [];
      for (const t of teams){
        const labels = new Set([t.canonical, ...(t.aliases||[])]);
        for (const lbl of labels){
          const k = norm(lbl);
          if (!k) continue;
          if (!idx.has(k)) idx.set(k, new Set());
          const set = idx.get(k);
          for (const l2 of labels) set.add(l2);
        }
      }
      ALIAS_INDEX = idx;
      if (DEBUG) console.log(`[aliases] Loaded ${j.teams?.length||0} teams from ${p}`);
      return ALIAS_INDEX;
    } catch {}
  }
  ALIAS_INDEX = new Map();
  if (DEBUG) console.log('[aliases] No data/soccer_teams.json found; using built-ins only');
  return ALIAS_INDEX;
}

// Built-in safety net for common cases (symmetric at runtime)
const TEAM_SYNONYMS = {
  'Paris Saint-Germain': ['PSG','Paris SG','Paris St Germain','Paris St-G','Paris St G'],
  'Tottenham Hotspur': ['Tottenham','Spurs'],
  'Leicester City': ['Leicester'],
  'Birmingham City': ['Birmingham'],
  'Exeter City': ['Exeter'],
  'Cheltenham Town': ['Cheltenham'],
  'Sheffield United': ['Sheffield Utd','Sheff Utd'],
  'Huddersfield Town': ['Huddersfield'],
};

function buildSymmetricSynonyms(){
  const map = new Map(); // label -> Set(all labels in its group)
  for (const [canon, arr] of Object.entries(TEAM_SYNONYMS)){
    const group = new Set([canon, ...arr]);
    for (const lbl of group){
      const k = norm(lbl);
      if (!map.has(k)) map.set(k, new Set());
      for (const l2 of group) map.get(k).add(l2);
    }
  }
  return map;
}
const BUILTIN_SYM = buildSymmetricSynonyms();

async function teamQueries(team){
  const q = new Set([team]);
  try {
    const idx = await loadAliasIndex();
    const hit = idx.get(norm(team));
    if (hit) for (const lbl of hit) q.add(lbl);
  } catch {}
  const b = BUILTIN_SYM.get(norm(team));
  if (b) for (const lbl of b) q.add(lbl);
  return Array.from(q);
}

async function safeListMarketCatalogue(filter, maxResults=200, projection=['EVENT','RUNNER_DESCRIPTION','MARKET_START_TIME']){
  try { return await listMarketCatalogue(filter, maxResults, projection); } catch (e) {
    if (DEBUG) console.log('[catalogue err]', e.message);
    const f1 = { ...filter }; delete f1.marketStartTime;
    try { const r1 = await listMarketCatalogue(f1, maxResults, projection); if (r1 && r1.length) return r1; } catch {}
    const f2 = { ...f1 }; delete f2.textQuery;
    try { const r2 = await listMarketCatalogue(f2, maxResults, projection); if (r2 && r2.length) return r2; } catch {}
    return [];
  }
}

// ---------- Betfair catalogue lookups -------------------------------------
async function findMatchOddsMarketForTeam(team, hoursAhead=120){
  const queries = await teamQueries(team);
  for (const q of queries){
    let cats = await safeListMarketCatalogue({ eventTypeIds:[SOCCER_EVENT_TYPE_ID], marketTypeCodes:['MATCH_ODDS'], marketStartTime: timeWindowFilter(hoursAhead), textQuery:q }, 200, ['EVENT','RUNNER_DESCRIPTION','MARKET_START_TIME']);
    if (!cats || cats.length===0){
      const all = await safeListMarketCatalogue({ eventTypeIds:[SOCCER_EVENT_TYPE_ID], marketStartTime: timeWindowFilter(hoursAhead), textQuery:q }, 400, ['EVENT','RUNNER_DESCRIPTION','MARKET_START_TIME']);
      cats = (all||[]).filter(c => /\bmatch\s*odds\b/i.test(c.marketName||''));
    }
    const scored = (cats||[]).map(m => {
      const runners = (m.runners||[]).map(r=>r.runnerName||'');
      const hasTeam = runners.some(r => norm(r).includes(norm(q)));
      return { m, hasTeam, t: Date.parse(m.marketStartTime || (m.event && m.event.openDate) || '') };
    }).filter(x=>x.hasTeam).sort((a,b)=>a.t-b.t);
    if (scored.length) return { market: scored[0].m, queryUsed: q };
  }
  return null;
}

async function findMO_BTTS_MarketForTeam(team, hoursAhead=120){
  const queries = await teamQueries(team);
  for (const q of queries){
    let cats = await safeListMarketCatalogue({ eventTypeIds:[SOCCER_EVENT_TYPE_ID], marketTypeCodes:['MATCH_ODDS_AND_BOTH_TEAMS_TO_SCORE'], marketStartTime: timeWindowFilter(hoursAhead), textQuery:q }, 200, ['EVENT','RUNNER_DESCRIPTION','MARKET_START_TIME']);
    if (!cats || cats.length===0){
      const all = await safeListMarketCatalogue({ eventTypeIds:[SOCCER_EVENT_TYPE_ID], marketStartTime: timeWindowFilter(hoursAhead), textQuery:q }, 400, ['EVENT','RUNNER_DESCRIPTION','MARKET_START_TIME']);
      cats = (all||[]).filter(c => /match\s*odds\s*and\s*both\s*teams\s*to\s*score/i.test(c.marketName||''));
    }
    const scored = (cats||[]).map(m => {
      const runners=(m.runners||[]).map(r=>r.runnerName||'');
      const has = runners.some(r => /yes$/i.test(r) && norm(r).includes(norm(q)));
      return { m, has, t: Date.parse(m.marketStartTime || (m.event && m.event.openDate) || '') };
    }).filter(x=>x.has).sort((a,b)=>a.t-b.t);
    if (scored.length) return { market: scored[0].m, queryUsed: q };
  }
  return null;
}

async function getRunnerMid(marketId, selectionId){
  const books = await listMarketBookSafe([marketId]);
  const book = books && books[0];
  if (!book || !book.runners) return null;
  const r = book.runners.find(x => String(x.selectionId) === String(selectionId));
  if (!r || !r.ex) return null;
  return midFromBestOffers(r.ex);
}

function runnerMatchesAnyQuery(runnerName, team, queries){
  const rn = norm(runnerName);
  if (sameTeam(runnerName, team)) return true;
  for (const q of queries){ if (rn.includes(norm(q))) return true; }
  return false;
}

// ---------- Offer → Betfair map & valuation --------------------------------
async function valueOffer(offer, thresholds){
  const { maxSpreadPct=20, minLiquidity=50, threshold=1.05 } = thresholds || {}; // default spread 20%
  const legs = [];
  let latestKO = 0;

  if (offer.kind === 'ALL_TO_WIN'){
    for (const leg of offer.legs){
      const team = leg.team;
      const found = await findMatchOddsMarketForTeam(team);
      if (!found) { if (DEBUG) console.log('[skip] no MATCH_ODDS for', team); return null; }
      const { market:cat } = found;
      const queries = await teamQueries(team);
      const runner = (cat.runners||[]).find(r => runnerMatchesAnyQuery(r.runnerName, team, queries));
      if (!runner) { if (DEBUG) console.log('[skip] no runner match in MO for', team, 'queries=', queries); return null; }
      const mid = await getRunnerMid(cat.marketId, runner.selectionId);
      if (!mid) { if (DEBUG) console.log('[skip] no prices for', team); return null; }
      if (mid.spreadPct > maxSpreadPct || mid.liq < minLiquidity) { if (DEBUG) console.log('[skip] filters', team, mid); return null; }
      const ts = Date.parse(cat.marketStartTime||'');
      if (Number.isFinite(ts)) latestKO = Math.max(latestKO, ts);
      legs.push({ kind:'MATCH_ODDS', team, bfMarketId:cat.marketId, bfRunnerId:runner.selectionId, bfRunnerName:runner.runnerName, ko:cat.marketStartTime, ...mid });
    }
  } else if (offer.kind === 'BOTH_TO_WIN_AND_ALL_TEAMS_SCORE'){
    for (const leg of offer.legs){
      const team = leg.team;
      const found = await findMO_BTTS_MarketForTeam(team);
      if (!found) { if (DEBUG) console.log('[skip] no MO&BTTS for', team); return null; }
      const { market:cat } = found;
      const queries = await teamQueries(team);
      const runner = (cat.runners||[]).find(r => /yes$/i.test(r.runnerName) && runnerMatchesAnyQuery((r.runnerName.split('/')[0]||r.runnerName), team, queries));
      if (!runner) { if (DEBUG) console.log('[skip] no Team/Yes runner for', team, 'queries=', queries); return null; }
      const mid = await getRunnerMid(cat.marketId, runner.selectionId);
      if (!mid) { if (DEBUG) console.log('[skip] no prices for', team); return null; }
      if (mid.spreadPct > maxSpreadPct || mid.liq < minLiquidity) { if (DEBUG) console.log('[skip] filters', team, mid); return null; }
      const ts = Date.parse(cat.marketStartTime||'');
      if (Number.isFinite(ts)) latestKO = Math.max(latestKO, ts);
      legs.push({ kind:'MATCH_ODDS_AND_BTTS', team, bfMarketId:cat.marketId, bfRunnerId:runner.selectionId, bfRunnerName:runner.runnerName, ko:cat.marketStartTime, ...mid });
    }
  } else {
    return null; // not handled yet
  }

  const fair = legs.reduce((acc, l) => acc * l.mid, 1);
  const rating = (offer.boostedOdds || 0) / fair;
  if (!(rating >= threshold)) { if (DEBUG) console.log('[skip] rating below threshold', rating.toFixed(3), 'for', offer.betText); return null; }

  const mapping = { bookie: offer.bookie, kind: offer.kind, legs, latestKO: latestKO>0 ? new Date(latestKO).toISOString() : null };
  return { fair, rating, mapping };
}

async function run(file, urlOverride, thresholds){
  const html = await fsp.readFile(path.resolve(file), 'utf8');
  let sourceUrl = urlOverride || '';
  if (!sourceUrl){ try { const meta = JSON.parse(await fsp.readFile(path.resolve(file).replace(/\.html$/i,'.meta.json'),'utf8')); sourceUrl = meta.url || ''; } catch {}
  }
  const offers = parseWilliamHillHTML(html, sourceUrl);
  if (DEBUG) console.log(`[parse] ${offers.length} WH boosts`);

  const results = [];
  for (const off of offers){
    if (off.kind === 'OVER_X_EACH_MATCH') { if (DEBUG) console.log('[skip] OVER_X_EACH_MATCH (phase 2)'); continue; }
    try {
      const v = await valueOffer(off, thresholds);
      if (!v) continue;
      const settleDate = v.mapping.latestKO ? ddmmyyyy(v.mapping.latestKO) : '';

      const payload = {
        date: ddmmyyyy(new Date()),
        bookie: 'William Hill',
        sport: 'Football',
        event: 'Multi',
        betText: off.betText,
        settleDate,
        odds: Number(off.boostedOdds),
        fairOdds: Number(v.fair.toFixed(3)),
        bookieUrl: sourceUrl,
        mappingJson: v.mapping,
      };

      if (DRY_RUN) {
        console.log('[DRY_RUN] Would write row:', { ...payload, rating: Number(v.rating.toFixed(3)) });
      } else {
        await appendToBetTrackerRow(payload);
        console.log('[WRITE] Row added for', off.betText, 'rating', v.rating.toFixed(3));
        await new Promise(r=>setTimeout(r, 600));
      }
      results.push({ bet: off.betText, boosted: off.boostedOdds, fair: v.fair, rating: v.rating, legs: v.mapping.legs.length });
    } catch (err) {
      console.error('[error] valueOffer failed for', off.betText, '-', err.message);
    }
  }
  return results;
}

async function main(){
  const [cmd, ...rest] = process.argv.slice(2);
  const args = Object.fromEntries(rest.map(x=>x.split('=')));
  if (cmd !== 'run') {
    console.log('Usage: node scripts/williamhill/wh_value_check.v5.js run --file="./scripts/williamhill/snapshots/<file>.html" [--url="https://..."] [--threshold=1.05] [--minliq=50] [--maxspread=20]');
    process.exit(1);
  }
  const file = args['--file']; if (!file){ console.error('Missing --file'); process.exit(1);} 
  const thresholds = {
    threshold: Number(args['--threshold']||'1.05'),
    minLiquidity: Number(args['--minliq']||'50'),
    maxSpreadPct: Number(args['--maxspread']||'20'),
  };
  const url = args['--url'] || '';
  const res = await run(file, url, thresholds);
  console.log('Value offers:', res.map(r=>({ bet:r.bet, rating: Number(r.rating.toFixed? r.rating.toFixed(3) : r.rating) })));
}

if (require.main === module) { main().catch(err => { console.error(err); process.exit(1); }); }

module.exports = { run, valueOffer, findMatchOddsMarketForTeam, findMO_BTTS_MarketForTeam, getRunnerMid, teamQueries };