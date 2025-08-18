// File: settlement_worker.js
// Polls Bet Tracker for approved (M="Y") pending rows (L="P") with mapping JSON in X,
// queries Betfair for each leg, then writes W/L/V into Bet Tracker column L.
//
// Run via cron every 3–5 minutes. It automatically limits lookups to rows near KO
// using the per-row mapping.latestKO (full datetime), because Bet Tracker G is date-only.
//
// ENV required:
//   BET_TRACKER_SHEET_ID (falls back to default in sheets.js)
//   BETFAIR_APP_KEY, BETFAIR_SESSION_TOKEN
// Optional tuning:
//   NEAR_BEFORE_MIN=120   (minutes before KO to start frequent checks)
//   NEAR_AFTER_MIN=30     (minutes after KO to continue checks)
//   MAX_MARKETS_PER_CALL=40

const { getBetTrackerPendingWithMapping, updateBetTrackerResult } = require('./sheets');
const { listMarketBook } = require('./betfair');

const NEAR_BEFORE_MIN = parseInt(process.env.NEAR_BEFORE_MIN || '120', 10);
const NEAR_AFTER_MIN  = parseInt(process.env.NEAR_AFTER_MIN  || '30', 10);
const MAX_MARKETS_PER_CALL = parseInt(process.env.MAX_MARKETS_PER_CALL || '40', 10);

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i+n));
  return out;
}

function minutesDiff(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

function classifyLegResult(mb, selectionId) {
  // Returns 'W' | 'L' | 'V' | 'P'
  if (!mb) return 'P';
  const status = (mb.status || '').toUpperCase();
  const runners = mb.runners || [];

  if (status === 'CLOSED') {
    const r = runners.find(x => x.selectionId === selectionId);
    const anyWinner = runners.some(x => (x.status || '').toUpperCase() === 'WINNER');
    if (!r) {
      // If our selection vanished and there's no winner, assume void
      return anyWinner ? 'L' : 'V';
    }
    const rs = (r.status || '').toUpperCase();
    if (rs === 'WINNER') return 'W';
    if (rs === 'LOSER')  return 'L';
    // No explicit result but market is closed
    return anyWinner ? 'L' : 'V';
  }

  if (status === 'INACTIVE') {
    // Pre-open market; not settled
    return 'P';
  }

  if (status === 'SUSPENDED' || status === 'OPEN') {
    // Still running / in-play / suspended → pending
    return 'P';
  }

  // Fallback
  return 'P';
}

async function main() {
  const now = new Date();
  const nearStart = new Date(now.getTime() - NEAR_AFTER_MIN * 60000); // window lower bound after KO
  const tasks = await getBetTrackerPendingWithMapping();

  // Filter to rows near KO using mapping.latestKO (full datetime).
  const eligible = tasks.filter(t => {
    if (!t.latestKO) return true; // no time → check anyway
    const ko = new Date(t.latestKO);
    const minsToKO = minutesDiff(ko, now);
    return (minsToKO <= NEAR_BEFORE_MIN) && (minutesDiff(now, ko) <= NEAR_AFTER_MIN + 180); // up to 3h after
  });

  // Aggregate marketIds → fetch in batches
  const allMarketIds = Array.from(new Set(eligible.flatMap(t => t.marketIds))).filter(Boolean);
  const books = {};
  for (const ids of chunk(allMarketIds, MAX_MARKETS_PER_CALL)) {
    if (ids.length === 0) continue;
    try {
      const res = await listMarketBook(ids, { withPrices: false });
      for (const mb of res || []) books[mb.marketId] = mb;
    } catch (e) {
      console.error('[Betfair] listMarketBook failed:', e.message);
    }
  }

  // Per row evaluation
  for (const row of eligible) {
    const legs = (row.mapping.legs || []).filter(l => l.bfMarketId && l.selectionId);
    if (legs.length === 0) continue;

    let anyVoid = false;
    let anyLose = false;
    let allWin  = true;

    for (const leg of legs) {
      const mb = books[leg.bfMarketId];
      const r  = classifyLegResult(mb, leg.selectionId);
      if (r === 'V') anyVoid = true;
      if (r === 'L') anyLose = true;
      if (r !== 'W') allWin  = false;
      if (r === 'L') break; // early exit
    }

    let newResult = null;
    if (anyLose) newResult = 'L';
    else if (anyVoid) newResult = 'V';
    else if (allWin)  newResult = 'W';

    if (newResult) {
      try {
        await updateBetTrackerResult(row.rowNumber, newResult);
        console.log(`Row ${row.rowNumber} → ${newResult}`);
      } catch (e) {
        console.error(`Failed to update row ${row.rowNumber}:`, e.message);
      }
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main };