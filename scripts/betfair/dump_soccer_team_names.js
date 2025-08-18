// File: scripts/betfair/dump_soccer_team_names.js
// Purpose: Pull how Betfair list team names (football) and save a JSON inventory
//
// What it does
//  - Calls listMarketCatalogue for Football (eventTypeId=1), marketType MATCH_ODDS
//  - Within a time window (default 14 days), no textQuery, so we get *everything*
//  - Extracts runner names (teams) + competition + sample market info
//  - Writes to data/soccer_teams.json (canonical + aliases) and prints a summary
//
// Usage (Windows CMD):
//  set BETFAIR_APP_KEY=YOUR_APP_KEY
//  set BETFAIR_SESSION_TOKEN=YOUR_SESSION_TOKEN
//  set DEBUG=true
//  node scripts\betfair\dump_soccer_team_names.js --hours=336 --out=data/soccer_teams.json
//
// Notes:
//  - If a team (e.g., PSG) doesn't appear, it's usually because they have no
//    MATCH_ODDS market in the selected window. Increase --hours (e.g., 720).
//  - This script only inspects MATCH_ODDS; MO&BTTS uses the same underlying
//    event/teams but different market type.

const fsp = require('fs/promises');
const path = require('path');
const { listMarketCatalogue, timeWindowFilter } = require('../../lib/betfair.v2');

const SOCCER_EVENT_TYPE_ID = '1';

function norm(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\b(fc|afc|cf)\b/g,'').replace(/\s+/g,' ').trim(); }

async function ensureDir(p){ await fsp.mkdir(p,{recursive:true}); }

function parseArgs(){
  const raw = process.argv.slice(2);
  const args = Object.fromEntries(raw.map(x=>{
    const i=x.indexOf('=');
    return i>0 ? [x.slice(0,i), x.slice(i+1)] : [x,true];
  }));
  return {
    hours: Number(args['--hours']||'336'),
    out: args['--out'] || 'data/soccer_teams.json',
  };
}

async function main(){
  const { hours, out } = parseArgs();
  const filter = {
    eventTypeIds: [SOCCER_EVENT_TYPE_ID],
    marketTypeCodes: ['MATCH_ODDS'],
    marketStartTime: timeWindowFilter(hours),
  };
  const cats = await listMarketCatalogue(filter, 1000, ['EVENT','RUNNER_DESCRIPTION','COMPETITION']);
  if (!cats || cats.length===0){
    console.log('No markets returned. Try increasing --hours.');
    return;
  }

  // Build alias map: key = normalised name, values = set of observed labels
  const aliasMap = new Map();
  const teamMeta = new Map(); // key = observed label, value = { competitions:Set, sample:[{marketId,...}, ..] }

  for (const m of cats){
    const comp = (m.competition && m.competition.name) || '';
    const start = m.marketStartTime;
    const marketInfo = { marketId: m.marketId, marketName: m.marketName, competition: comp, marketStartTime: start };
    for (const r of (m.runners||[])){
      const label = r.runnerName || '';
      const key = norm(label);
      if (!key) continue;
      if (!aliasMap.has(key)) aliasMap.set(key, new Set());
      aliasMap.get(key).add(label);

      if (!teamMeta.has(label)) teamMeta.set(label, { competitions: new Set(), sample: [] });
      const meta = teamMeta.get(label);
      if (comp) meta.competitions.add(comp);
      if (meta.sample.length < 3) meta.sample.push(marketInfo);
    }
  }

  // Choose a canonical display name per normalised key: pick the most frequent label
  const freq = new Map(); // label -> count
  for (const m of cats){
    for (const r of (m.runners||[])){
      const label = r.runnerName || '';
      if (!label) continue;
      freq.set(label, (freq.get(label)||0) + 1);
    }
  }

  const entries = [];
  for (const [key, labelsSet] of aliasMap.entries()){
    const labels = Array.from(labelsSet);
    labels.sort((a,b)=> (freq.get(b)||0) - (freq.get(a)||0));
    const canonical = labels[0];
    const meta = teamMeta.get(canonical) || { competitions:new Set(), sample:[] };
    entries.push({
      canonical,
      normalised: key,
      aliases: labels,
      competitions: Array.from(meta.competitions||new Set()).sort(),
      sampleMarkets: meta.sample,
    });
  }

  // Sort alphabetically by canonical
  entries.sort((a,b)=> a.canonical.localeCompare(b.canonical));

  // Write JSON
  const outPath = path.resolve(out);
  await ensureDir(path.dirname(outPath));
  const payload = { updatedAt: new Date().toISOString(), windowHours: hours, totalMarkets: cats.length, totalTeams: entries.length, teams: entries };
  await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');

  // Print a quick summary
  console.log(`Saved ${entries.length} teams from ${cats.length} markets to ${outPath}`);
  console.log('Examples:');
  for (const e of entries.slice(0, 10)){
    console.log('-', e.canonical, '→', e.aliases.slice(0,4).join(' | '));
  }
  console.log('Tip: open the JSON and search for terms like "Paris", "PSG", "Sheffield" to see exact labels.');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {};