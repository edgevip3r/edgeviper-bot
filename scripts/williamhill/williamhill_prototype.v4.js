// File: scripts/williamhill/williamhill_prototype.v4.js
// William Hill "Price Boost" football multiples — robust DOM parser
// Changes vs v3.fix:
//  • No more scoping to the <h2> section (which lost siblings) — we now
//    locate each boost row *globally* by its enhanced-odds button and walk up
//    to .btmarket__selection for clean, per-row extraction.
//  • Reads BOOSTED odds from button data-num/data-denom (fallback data-odds).
//  • Cleans bet text: strips trailing ( ... ) like (90 mins) and trailing
//    "Was 13/8" segments.
//  • Skips player-prop rows like "Both To Score Anytime".
//  • Classifies: All To Win, Over X Goals in Each Match, Match Odds & BTTS.
//  • NEW: stealth helpers + hardened snapshot function; snapshot branch now uses
//         snapshotWilliamHillHardened() and writes a .meta.json with the URL.
//
// Usage:
//   node scripts/williamhill/williamhill_prototype.v4.js snapshot --url="https://sports.williamhill.com/betting/en-gb/football/.../football-boosted-specials"
//   node scripts/williamhill/williamhill_prototype.v4.js parse --file="./scripts/williamhill/snapshots/<file>.html"
//   node scripts/williamhill/williamhill_prototype.v4.js publish --file="./scripts/williamhill/snapshots/<file>.html"
//
// ENV:
//   BET_TRACKER_SHEET_ID (optional; falls back to helper default)
//   DRY_RUN=true     (preview write payloads)
//   HEADLESS=false   (to watch the browser during snapshot)
//   DEBUG=true       (extra logs while parsing)

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const HEADLESS = !/^false$/i.test(process.env.HEADLESS || 'true');
const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');

let appendToBetTrackerRow;
try { ({ appendToBetTrackerRow } = require('../../lib/sheets.bettracker')); } catch (_) {}

function nowStamp(){ const d=new Date(); const pad=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; }
async function ensureDir(dir){ await fsp.mkdir(dir,{recursive:true}); }
async function autoScroll(page){ await page.evaluate(async()=>{ await new Promise(res=>{ let total=0; const step=800; const t=setInterval(()=>{ const sh=document.body.scrollHeight; window.scrollBy(0,step); total+=step; if(total>=sh-window.innerHeight){ clearInterval(t); res(); } },300); }); }); }
async function acceptConsent(page){ const sels=['#onetrust-accept-btn-handler','button:has-text("Accept all")','button:has-text("Accept All")','button:has-text("Accept")','button:has-text("I agree")','[aria-label*="accept" i]','[data-testid*="accept" i]']; for(const s of sels){ const loc=page.locator(s).first(); if(await loc.count()){ try{ await loc.click({timeout:1500}); return true; }catch{} } } for(const f of page.frames()){ for(const s of sels){ try{ const loc=f.locator(s).first(); if(await loc.count()){ await loc.click({timeout:1200}); return true; } }catch{} } } return false; }

// ---- stealth helpers (added) ----------------------------------------------
function rand(min, max){ return Math.floor(Math.random() * (max - min + 1)) + min; }
function choice(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
async function humanPause(page, min=350, max=900){ await page.waitForTimeout(rand(min, max)); }

const COMMON_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15'
];
function randomUA(){ return choice(COMMON_UAS); }

async function waitForNetworkQuiet(page, { idleTime = 1200, timeout = 15000 } = {}){
  let lastActivity = Date.now();
  const onReq = () => (lastActivity = Date.now());
  const onRes = () => (lastActivity = Date.now());
  page.on('request', onReq); page.on('requestfinished', onRes); page.on('requestfailed', onRes);
  try {
    const start = Date.now();
    while (Date.now() - start < timeout){
      if (Date.now() - lastActivity >= idleTime) return true;
      await page.waitForTimeout(250);
    }
    return false; // timed out but continue
  } finally {
    page.off('request', onReq); page.off('requestfinished', onRes); page.off('requestfailed', onRes);
  }
}

// --- polite context + retry/backoff (added)
async function newWHContext(chromiumLib){
  const browser = await chromiumLib.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: randomUA(),
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1280 + rand(-80, 60), height: 900 + rand(-50, 80) },
  });
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (/\.mp4|\.webm|\.m3u8/i.test(url) || ['media','eventsource'].includes(type)) return route.abort();
    if (/analytics|doubleclick|googletagmanager|hotjar|optimizely|scorecardresearch/i.test(url)) return route.abort();
    await new Promise(res => setTimeout(res, rand(40, 120)));
    return route.continue();
  });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-GB,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'DNT': '1',
    'Referer': 'https://sports.williamhill.com/'
  });
  return { browser, context, page };
}

async function retryNav(page, url, { attempts = 3, baseDelay = 800 } = {}){
  let lastResp = null;
  for (let i = 0; i < attempts; i++){
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      lastResp = resp;
      const status = resp ? resp.status() : 0;
      if (!status || status < 500) return resp;
    } catch (e) {
      if (DEBUG) console.log(`[nav] attempt ${i+1} failed:`, e.message);
    }
    const backoff = baseDelay * Math.pow(2, i) + rand(100, 400);
    if (DEBUG) console.log(`[nav] backoff ${backoff}ms before retry`);
    await page.waitForTimeout(backoff);
  }
  return lastResp;
}

async function snapshotWilliamHill(url){ const outDir=path.join(__dirname,'snapshots'); await ensureDir(outDir); const ts=nowStamp(); const base=url.replace(/https?:\/\//,'').replace(/\W+/g,'_').slice(0,60); const htmlPath=path.join(outDir,`${ts}_${base}.html`); const pngPath=path.join(outDir,`${ts}_${base}.png`); const browser=await chromium.launch({headless:HEADLESS}); const page=await browser.newPage({viewport:{width:1366,height:1000}, userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'}); await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000}); await acceptConsent(page).catch(()=>{}); await page.waitForTimeout(900); await autoScroll(page); try{ await page.waitForLoadState('networkidle',{timeout:12000}); }catch{ if(DEBUG) console.log('[snapshot] networkidle not reached, continuing…'); } await page.screenshot({path:pngPath,fullPage:true}); const content=await page.content(); await fsp.writeFile(htmlPath,content,'utf8'); await browser.close(); return {htmlPath,pngPath}; }

// Hardened snapshot (added)
async function snapshotWilliamHillHardened(url, opts = {}){
  const outDir = path.join(__dirname, 'snapshots');
  await ensureDir(outDir);
  const ts = nowStamp();
  const u = new URL(url);
  const base = (u.hostname + u.pathname).replace(/[^A-Za-z0-9]+/g, '_').slice(0,60);
  const htmlPath = path.join(outDir, `${ts}_${base}.html`);
  const pngPath  = path.join(outDir, `${ts}_${base}.png`);
  const metaPath = htmlPath.replace(/\.html$/i, '.meta.json');

  const { browser, page } = await newWHContext(chromium);

  // Warm-up first (lighter target) with retry/backoff
  try { await retryNav(page, 'https://sports.williamhill.com/', { attempts: 2, baseDelay: 600 }); } catch {}
  await humanPause(page, 300, 900);

  // Then target page with retry/backoff
  const resp = await retryNav(page, url, { attempts: 3, baseDelay: 800 });

  await acceptConsent(page).catch(()=>{});
  await humanPause(page, 500, 1200);
  await autoScroll(page);
  await waitForNetworkQuiet(page, { idleTime: 1200, timeout: 15000 });
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}

  await page.screenshot({ path: pngPath, fullPage: true });
  const content = await page.content();
  await fsp.writeFile(htmlPath, content, 'utf8');
  const ua = await page.evaluate(() => navigator.userAgent);
  await fsp.writeFile(metaPath, JSON.stringify({ url, ts: new Date().toISOString(), userAgent: ua }, null, 2), 'utf8');

  await browser.close();
  return { htmlPath, pngPath, metaPath, status: resp && resp.status ? resp.status() : null };
}

// ---------------- Parsing helpers ----------------
function toTitleCase(s){ return s.replace(/\s+/g,' ').trim().toLowerCase().replace(/\b\w/g,m=>m.toUpperCase()); }
function normaliseTeam(raw){ if(!raw) return ''; let s=raw.replace(/\b(to\s+win|both\s+to\s+win|win|match|result|either|team|teams)\b/gi,'').replace(/[()\-–•·]/g,' ').replace(/\s+/g,' ').trim(); s=s.replace(/\bMan\.?\s*Utd\b/i,'Manchester United').replace(/\bMan\.?\s*City\b/i,'Manchester City').replace(/\bSpurs\b/i,'Tottenham').replace(/\bPSG\b/i,'Paris Saint-Germain'); return toTitleCase(s); }
function cleanBetText(name){ if(!name) return ''; let s=name.replace(/\s+/g,' ').trim(); s=s.replace(/\s+Was\s+\d+\s*\/\s*\d+.*$/i,'').trim(); s=s.replace(/\s*\([^)]*\)\s*$/i,'').trim(); return s; }
function fracStrToDec(frac){ const m=(frac||'').match(/^(\d{1,3})\s*\/\s*(\d{1,2})$/); if(!m) return null; const a=parseFloat(m[1]); const b=parseFloat(m[2]); if(!b) return null; const dec=1+(a/b); return dec>=1.2 && dec<=200?dec:null; }
function buttonOddsToDec($btn){ if(!$btn||!$btn.attr) return null; const num=parseFloat($btn.attr('data-num')); const denom=parseFloat($btn.attr('data-denom')); if(!isNaN(num)&&!isNaN(denom)&&denom>0) return 1+(num/denom); const d=$btn.attr('data-odds')||$btn.find('.betbutton__odds').text().trim(); return fracStrToDec(d); }
function extractTeamsFromBetText(text){ if(!text) return []; const parts=text.split(/\s*(?:&|\+|,|\bx\b|\b×\b|\band\b)\s*/i).map(s=>s.trim()).filter(Boolean); const teams=parts.map(normaliseTeam).filter(s=>s&&/[A-Za-z]/.test(s)&&s.length>=3).filter(s=>!/to\s*win/i.test(s)); const seen=new Set(); const uniq=[]; for(const t of teams){ const k=t.toLowerCase(); if(!seen.has(k)){ seen.add(k); uniq.push(t);} } return uniq.slice(0,8); }

// Classifiers
function classifyAllToWin(text){ const m=text.match(/^(.*)\s+All\s+To\s+Win\b/i); if(!m) return null; const teams=extractTeamsFromBetText(m[1]); if(teams.length<2) return null; return {kind:'ALL_TO_WIN', legs:teams.map(t=>({team:t, market:'Match Odds', selection:`${t} to Win`}))}; }
function classifyOverXEachMatch(text){ const m=text.match(/Over\s+(\d+(?:\.5)?)\s+Goal(?:s)?\s+In\s+Each\s+Of\s+(?:[A-Za-z]+[’']s\s+)?(\d+)\s+(.+?)\s+Matches/i); if(!m) return null; const goals=parseFloat(m[1]); const matchCount=parseInt(m[2],10); const competition=m[3].trim(); return {kind:'OVER_X_EACH_MATCH', goals, matchCount, competition, minutes:90, legs:Array.from({length:matchCount},()=>({market:`Over ${goals} Goals`, scope:competition}))}; }
function classifyBothToWinAllTeamsScore(text){ const m=text.match(/^(.*)\s+Both\s+To\s+Win\s*&\s*All\s+(\d+)\s+Teams\s+To\s+Score\b/i); if(!m) return null; const teams=extractTeamsFromBetText(m[1]); if(teams.length<2) return null; return {kind:'BOTH_TO_WIN_AND_ALL_TEAMS_SCORE', legs:teams.map(t=>({team:t, market:'Match Odds & BTTS', selection:`${t}/Yes`}))}; }
function isPlayerProp(text){ return /Both\s+To\s+Score\s+Anytime/i.test(text); }
function classify(text){ return classifyAllToWin(text) || classifyOverXEachMatch(text) || classifyBothToWinAllTeamsScore(text) || null; }

function makeOfferSignature(offer){ const day=new Date().toISOString().slice(0,10); const legs=(offer.legs||[]).map(l=>(l.team||l.market||'').toString().toLowerCase()).sort().join('+'); const payload=`${offer.sport||'Football'}|${offer.kind||'MULTI'}|${legs}|${day}`; return crypto.createHash('sha1').update(payload).digest('hex'); }

function parseWilliamHillHTML(html, sourceUrl){ const $=cheerio.load(html);
  const offers=[];
  $('button.betbutton--enhanced-odds, button.enhanced-offers__button').each((_, btn)=>{
    const $btn=$(btn);
    const $row=$btn.closest('.btmarket__selection');
    if(!$row||!$row.length) return;
    const rawName=$row.find('.btmarket__name span').text().replace(/\s+/g,' ').trim();
    const name=cleanBetText(rawName);
    if(!name) return;
    if(isPlayerProp(name)){ if(DEBUG) console.log('[skip player-prop]', name); return; }
    const decOdds=buttonOddsToDec($btn);
    if(!decOdds){ if(DEBUG) console.log('[no boosted odds]', name); return; }
    const cls=classify(name);
    if(!cls){ if(DEBUG) console.log('[unclassified]', name); return; }
    const offer={ bookie:'William Hill', sport:'Football', offerType:'Price Boost', kind:cls.kind, legs:cls.legs||[], betText:name, boostedOdds:decOdds, sourceUrl:sourceUrl||'' };
    offer.signature=makeOfferSignature(offer);
    offers.push(offer);
  });
  return offers; }

function pickBestBySignature(offers){ const map=new Map(); for(const o of offers){ const k=o.signature||makeOfferSignature(o); const p=map.get(k); if(!p||(o.boostedOdds||0)>(p.boostedOdds||0)) map.set(k,o);} return Array.from(map.values()); }
function formatDDMMYYYY(d=new Date()){ const pad=n=>String(n).padStart(2,'0'); return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`; }
async function publishOffersToBetTracker(offers){ if(!appendToBetTrackerRow) throw new Error('sheets.bettracker helper not available (did you copy lib/sheets.bettracker.js?)'); const dryRun=/^true$/i.test(process.env.DRY_RUN||'true'); for(const o of offers){ const payload={ date:formatDDMMYYYY(new Date()), bookie:o.bookie||'William Hill', sport:o.sport||'Football', event:'Multi', betText:o.betText, settleDate:'', odds:o.boostedOdds, fairOdds:'', bookieUrl:o.sourceUrl||'' }; if(dryRun){ console.log('[DRY_RUN] Would write row:',payload);} else { await appendToBetTrackerRow(payload); await new Promise(r=>setTimeout(r,1200)); } } }

// Read snapshot meta URL if available (pairs with the .html snapshot)
async function readMetaUrlFor(htmlFile){
  try {
    const metaPath = path.resolve(String(htmlFile).replace(/\.html$/i, '.meta.json'));
    const metaRaw = await fsp.readFile(metaPath, 'utf8');
    const meta = JSON.parse(metaRaw);
    return meta.url || '';
  } catch { return ''; }
}

async function main(){ const [cmd,...rest]=process.argv.slice(2); const args=Object.fromEntries(rest.map(x=>x.split('='))); if(cmd==='snapshot'){ const url=args['--url']; if(!url){ console.error('Usage: node scripts/williamhill/williamhill_prototype.v4.js snapshot --url="https://.../football-boosted-specials"'); process.exit(1);} const out=await snapshotWilliamHillHardened(url); console.log('Saved:',out); return; } if(cmd==='parse'){ const file=args['--file']; if(!file){ console.error('Usage: node scripts/williamhill/williamhill_prototype.v4.js parse --file="./scripts/williamhill/snapshots/<file>.html"'); process.exit(1);} const html=await fsp.readFile(path.resolve(file),'utf8'); const metaUrl = await readMetaUrlFor(path.resolve(file));
const offers = parseWilliamHillHTML(html, metaUrl); console.log(JSON.stringify(offers,null,2)); console.log(`Found ${offers.length} candidate WH price boosts.`); return; } if(cmd==='publish'){ const file=args['--file']; if(!file){ console.error('Usage: node scripts/williamhill/williamhill_prototype.v4.js publish --file="./scripts/williamhill/snapshots/<file>.html"'); process.exit(1);} const html=await fsp.readFile(path.resolve(file),'utf8'); const metaUrl = await readMetaUrlFor(path.resolve(file));
const offers = parseWilliamHillHTML(html, metaUrl); const best=pickBestBySignature(offers); console.log(`Publishing ${best.length} de-duplicated offers (DRY_RUN=${process.env.DRY_RUN||'true'})...`); await publishOffersToBetTracker(best); return; } console.log(`Unknown command. Try one of:\n  node scripts/williamhill/williamhill_prototype.v4.js snapshot --url="https://.../football-boosted-specials"\n  node scripts/williamhill/williamhill_prototype.v4.js parse --file="./scripts/williamhill/snapshots/<file>.html"\n  node scripts/williamhill/williamhill_prototype.v4.js publish --file="./scripts/williamhill/snapshots/<file>.html"`); }
if(require.main===module){ main().catch(err=>{ console.error(err); process.exit(1); }); }
module.exports={ snapshotWilliamHill, snapshotWilliamHillHardened, parseWilliamHillHTML, pickBestBySignature, publishOffersToBetTracker };