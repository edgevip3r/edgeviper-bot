// File: scripts/pricedup/pricedup_prototype.js
// Prototype to: (1) snapshot the PricedUp boosts page, (2) parse boosted doubles/trebles
// for Football/Tennis match odds, and (3) optionally publish to Bet Tracker (manual approval).
//
// Usage examples:
//   node scripts/pricedup/pricedup_prototype.js snapshot --url="https://pricedup.bet/sport-special/pricedup-pushes"
//   node scripts/pricedup/pricedup_prototype.js parse --file="./scripts/pricedup/snapshots/<file>.html"
//   node scripts/pricedup/pricedup_prototype.js publish --file="./scripts/pricedup/snapshots/<file>.html"
//
// ENV:
//   BET_TRACKER_SHEET_ID (optional; falls back to default in sheets.bettracker)
//   DRY_RUN=true (prevents publishing when using `publish`)

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

// Allow headful mode for debugging: set HEADLESS=false to watch the browser
const HEADLESS = !/^false$/i.test(process.env.HEADLESS || 'true');

// Use the Bet Tracker helper we created in /lib
let appendToBetTrackerRow;
try {
  ({ appendToBetTrackerRow } = require('../../lib/sheets.bettracker'));
} catch (e) {
  // Running standalone without sheets helper is fine for snapshot/parse
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 800;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
}

// --- Page helpers: consent + accordions -----------------------------------
async function acceptConsent(page) {
  const candidates = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    '[aria-label*="accept" i]',
    '[data-testid*="accept" i]'
  ];
  // Try on main page first
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try { await loc.click({ timeout: 1500 }); return true; } catch (_) {}
    }
  }
  // Try iframes (common for consent managers)
  for (const frame of page.frames()) {
    for (const sel of candidates) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.count()) { await loc.click({ timeout: 1200 }); return true; }
      } catch (_) {}
    }
  }
  return false;
}

async function expandAllBoostAccordions(page) {
  // Open <details> elements
  await page.evaluate(() => {
    document.querySelectorAll('details:not([open])').forEach(d => { d.open = true; });
  });

  const buttonSelectors = [
    '[aria-expanded="false"]',
    'button:has-text("Show more")',
    'button:has-text("Expand")',
    'button:has-text("View all")',
    'a:has-text("Show more")',
    'a:has-text("View all")',
  ];

  for (let pass = 0; pass < 3; pass++) {
    for (const sel of buttonSelectors) {
      const loc = page.locator(sel);
      const count = await loc.count();
      for (let i = 0; i < Math.min(count, 10); i++) {
        try { await loc.nth(i).click({ timeout: 800 }); } catch (_) {}
      }
    }
    // Some sections load after scroll
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await page.waitForTimeout(500);
  }
}

async function snapshotPricedUp(url) {
  const outDir = path.join(__dirname, 'snapshots');
  await ensureDir(outDir);
  const ts = nowStamp();
  const base = url.replace(/https?:\/\//, '').replace(/\W+/g, '_').slice(0, 40);
  const htmlPath = path.join(outDir, `${ts}_${base}.html`);
  const pngPath = path.join(outDir, `${ts}_${base}.png`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage({
    viewport: { width: 1366, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await acceptConsent(page).catch(() => {});
  await page.waitForTimeout(1200);
  await expandAllBoostAccordions(page).catch(() => {});
  await autoScroll(page);
	// Some sites never reach true "networkidle" due to analytics/polling; try briefly then continue
	try {
	  await page.waitForLoadState('networkidle', { timeout: 15000 });
	} catch (_) {
	  console.log('[snapshot] networkidle not reached in 15s, continuing…');
	}
	// Content-based readiness (prefer seeing any boost text)
	try {
	  await page.getByText(/boost|price boost|super boost/i).first().waitFor({ timeout: 8000 });
	} catch (_) {}

  await page.screenshot({ path: pngPath, fullPage: true });
  const content = await page.content();
  await fsp.writeFile(htmlPath, content, 'utf8');

  await browser.close();
  return { htmlPath, pngPath };
}

// --- Parsing helpers -------------------------------------------------------
function toTitleCase(s) {
  return s.replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function normaliseTeam(raw) {
  if (!raw) return '';
  let s = raw.replace(/\b(to\s+win|both\s+to\s+win|win|match|result|either|team|teams)\b/gi, '')
             .replace(/[()\-–•·]/g, ' ')
             .replace(/\s+/g, ' ')
             .trim();
  // Common short-name tidy-ups
  s = s.replace(/\bMan\.?\s*Utd\b/i, 'Manchester United')
       .replace(/\bMan\.?\s*City\b/i, 'Manchester City')
       .replace(/\bSpurs\b/i, 'Tottenham')
       .replace(/\bPSG\b/i, 'Paris Saint-Germain');
  return toTitleCase(s);
}

function fracToDec(text) {
  const m = text.match(/(\d+)\s*\/(\s*\d+)/);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[2]);
  if (!b) return null;
  return 1 + (a / b);
}

function findDecimalOdds(text) {
  // Try decimal first: 1.20, 2, 15.5
  const dec = text.match(/\b(\d{1,2}(?:\.\d{1,2})?)\b/g);
  const candidates = (dec || []).map(Number).filter(x => x >= 1.01 && x <= 200);
  if (candidates.length) {
    // Heuristic: take the largest as boosted price often displayed prominently
    return Math.max(...candidates);
  }
  const frac = fracToDec(text);
  return frac;
}

function extractTeamsFromBetText(text) {
  if (!text) return [];
  const parts = text.split(/\s*(?:&|\+|,|\bx\b|\b×\b|\band\b)\s*/i)
    .map(s => s.trim())
    .filter(Boolean);
  const teams = parts
    .map(normaliseTeam)
    .filter(s => s && /[A-Za-z]/.test(s) && s.length >= 3)
    .filter(s => !/to\s*win/i.test(s));
  const seen = new Set();
  const uniq = [];
  for (const t of teams) {
    const key = t.toLowerCase();
    if (!seen.has(key)) { seen.add(key); uniq.push(t); }
  }
  return uniq.slice(0, 4); // sanity limit
}

function makeOfferSignature(offer) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (coarse bucket)
  const legs = (offer.legs || []).map(l => normaliseTeam(l.team)).sort().join('+');
  const payload = `${offer.sport||'Football'}|1X2|${offer.multipleType||''}|${legs}|${day}`;
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function parsePricedUpHTML(html, sourceUrl) {
  const $ = cheerio.load(html);
  const textDump = $('body').text().replace(/\s+/g, ' ').trim();

  const candidates = [];
  $('[class*="boost" i], [class*="super" i], [class*="price" i]').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && /boost/i.test(t) && t.length > 10) candidates.push(t);
  });

  if (candidates.length === 0) {
    const m = textDump.match(/.{0,80}(?:super\s+boost|price\s+boost).{0,120}/gi) || [];
    for (const s of m) candidates.push(s);
  }

  const seen = new Set();
  const blocks = [];
  for (const c of candidates) {
    const k = c.toLowerCase();
    if (!seen.has(k)) { seen.add(k); blocks.push(c); }
  }

  const offers = [];
  for (const block of blocks) {
    const odds = findDecimalOdds(block);
    const teams = extractTeamsFromBetText(block);
    if (!odds || teams.length < 2) continue; // likely not a proper multi

    const multipleType = teams.length === 2 ? 'DOUBLE' : (teams.length === 3 ? 'TREBLE' : 'MULTI');
    const legs = teams.map(t => ({ sport: 'Football', market: 'Match Result', team: t }));

    const offer = {
      bookie: 'PricedUp',
      sport: 'Football',
      offerType: 'Boost',
      multipleType,
      betText: block,
      boostedOdds: odds,
      legs,
      sourceUrl: sourceUrl || ''
    };
    offer.signature = makeOfferSignature(offer);
    offers.push(offer);
  }

  return offers;
}

function pickBestBySignature(offers) {
  const map = new Map();
  for (const o of offers) {
    const k = o.signature || makeOfferSignature(o);
    const prev = map.get(k);
    if (!prev || (o.boostedOdds || 0) > (prev.boostedOdds || 0)) {
      map.set(k, o);
    }
  }
  return Array.from(map.values());
}

function formatDDMMYYYY(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
}

async function publishOffersToBetTracker(offers) {
  if (!appendToBetTrackerRow) throw new Error('sheets.bettracker helper not available (did you copy lib/sheets.bettracker.js?)');
  const dryRun = /^true$/i.test(process.env.DRY_RUN || 'true');

  for (const o of offers) {
    const payload = {
      date: formatDDMMYYYY(new Date()),
      bookie: o.bookie || 'PricedUp',
      sport: o.sport || 'Football',
      event: 'Multi',
      betText: o.betText,
      settleDate: '', // will fill KO date when matcher is added
      odds: o.boostedOdds,
      fairOdds: '',  // filled by valuer once exchange mids are fetched
      bookieUrl: o.sourceUrl || ''
    };

    if (dryRun) {
      console.log('[DRY_RUN] Would write row:', payload);
    } else {
      await appendToBetTrackerRow(payload);
      // Small delay to avoid spamming the sheet too fast during manual tests
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// --- CLI -------------------------------------------------------------------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = Object.fromEntries(rest.map(x => x.split('=')));

  if (cmd === 'snapshot') {
    const url = args['--url'];
    if (!url) {
      console.error('Usage: node scripts/pricedup/pricedup_prototype.js snapshot --url="https://pricedup.bet/sport-special/pricedup-pushes"');
      process.exit(1);
    }
    const out = await snapshotPricedUp(url);
    console.log('Saved:', out);
    return;
  }

  if (cmd === 'parse') {
    const file = args['--file'];
    if (!file) {
      console.error('Usage: node scripts/pricedup/pricedup_prototype.js parse --file="./scripts/pricedup/snapshots/<file>.html"');
      process.exit(1);
    }
    const html = await fsp.readFile(path.resolve(file), 'utf8');
    const offers = parsePricedUpHTML(html);
    console.log(JSON.stringify(offers, null, 2));
    console.log(`Found ${offers.length} candidate multi boosts.`);
    return;
  }

  if (cmd === 'publish') {
    const file = args['--file'];
    if (!file) {
      console.error('Usage: node scripts/pricedup/pricedup_prototype.js publish --file="./scripts/pricedup/snapshots/<file>.html"');
      process.exit(1);
    }
    const html = await fsp.readFile(path.resolve(file), 'utf8');
    const offers = parsePricedUpHTML(html, '');
    const best = pickBestBySignature(offers);
    console.log(`Publishing ${best.length} de-duplicated offers (DRY_RUN=${process.env.DRY_RUN || 'true'})...`);
    await publishOffersToBetTracker(best);
    return;
  }

  console.log(`Unknown command. Try one of:
  node scripts/pricedup/pricedup_prototype.js snapshot --url="https://pricedup.bet/sport-special/pricedup-pushes"
  node scripts/pricedup/pricedup_prototype.js parse --file="./scripts/pricedup/snapshots/<file>.html"
  node scripts/pricedup/pricedup_prototype.js publish --file="./scripts/pricedup/snapshots/<file>.html"`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  snapshotPricedUp,
  parsePricedUpHTML,
  pickBestBySignature,
  publishOffersToBetTracker,
};