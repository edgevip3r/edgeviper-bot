// File: /lib/sheets.bettracker.js
// Google Sheets helper focused on your Bet Tracker + (read-only) MasterBets.
// Uses a Service Account. Share your Sheet with the service account email (client_email).

const { google } = require('googleapis');
const path = require('path');

// Allow overriding credentials path via GOOGLE_APPLICATION_CREDENTIALS.
// Fallback to ./credentials.json next to this file.
const CREDS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'credentials.json');
const creds = require(CREDS_PATH);

// Default sheet IDs (fallback to env when present)
const DEFAULT_BET_TRACKER_SHEET_ID = '1uXjki0SE3CocWEg05bZZ_fB6IDnTE4gdhGsclgkQZww';

let sheetsClient;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// --------------------------- MasterBets helpers ----------------------------

/**
 * Fetch all rows from MasterBets, including header.
 */
async function fetchAllMasterRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'MasterBets!A:X'
  });
  return res.data.values || [];
}

/**
 * Fetch only new bets marked "S" for sending.
 * Returns [headerRow, ...rowsWithSendS]
 */
async function fetchNewBets() {
  const all = await fetchAllMasterRows();
  const header = all[0] || [];
  const body   = (all.slice(1) || []).filter(r => r[9] === 'S'); // col J (index 9)
  return [header, ...body];
}

/**
 * Marks a given MasterBets row’s Send-column cell to a new value.
 * @param {number} rowIndex  0-based index into the fetched array (so +1 for sheet)
 * @param {string} newVal    the value to write (e.g. "P")
 */
async function markRowSend(rowIndex, newVal) {
  const sheets = await getSheetsClient();
  const sheetName = 'MasterBets';
  const colLetter = 'J';  // Send column
  const sheetRow  = rowIndex + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${sheetName}!${colLetter}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ newVal ]] }
  });
}

// ---------------------------- Bet Tracker helpers --------------------------

/** Column indices (0-based) for Bet Tracker **/
const COL = {
  DATE: 0,       // A — DD/MM/YYYY
  BOOKIE: 2,     // C
  SPORT: 3,      // D
  EVENT: 4,      // E (we use "Multi")
  BET: 5,        // F — exact bookie text
  SETTLE_DATE: 6,// G — DD/MM/YYYY (no time)
  ODDS: 7,       // H — boosted odds
  FAIR: 8,       // I — fair odds
  RESULT: 11,    // L — "P"/"W"/"L"/"V"
  APPROVED: 12,  // M — "Y" when you approve
  BOOKIE_URL: 13,// N — deep link
  MAP_JSON: 23   // X — mapping JSON for settlement
};

/**
 * Append a new candidate bet into **Bet Tracker**, targeting the first truly
 * blank row (where column A is empty). Only populate the fields your Apps
 * Script later reads when you type "Y" in col M.
 *
 * We deliberately leave M blank so you can manually approve later with "Y".
 *
 * Env var: BET_TRACKER_SHEET_ID (falls back to DEFAULT_BET_TRACKER_SHEET_ID)
 * @param {object} row
 * @param {string} [row.spreadsheetId]
 * @param {string} [row.sheetName='Bet Tracker']
 * @param {string} row.date         // 'DD/MM/YYYY'
 * @param {string} row.bookie
 * @param {string} row.sport        // 'Football' | 'Tennis'
 * @param {string} [row.event='Multi']
 * @param {string} row.betText      // EXACT bookie boost text
 * @param {string} row.settleDate   // 'DD/MM/YYYY' (latest KO date only)
 * @param {number|string} row.odds  // boosted odds (number ok as string)
 * @param {number|string} row.fairOdds
 * @param {string} row.bookieUrl
 * @param {object|string} [row.mappingJson] // optional — stored in column X
 * @returns {Promise<{writeRow:number}>}
 */
async function appendToBetTrackerRow(row) {
  const sheets = await getSheetsClient();

  const {
    spreadsheetId = (process.env.BET_TRACKER_SHEET_ID || DEFAULT_BET_TRACKER_SHEET_ID),
    sheetName = 'Bet Tracker',
    date, bookie, sport, event = 'Multi', betText, settleDate, odds, fairOdds, bookieUrl, mappingJson
  } = row || {};

  if (!spreadsheetId) throw new Error('BET_TRACKER_SHEET_ID is required');

  // Find the first blank A cell
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:A`
  });
  const vals = res.data.values || [];
  let writeRow = vals.findIndex(r => !r[0] || r[0] === '') + 1; // 1-based
  if (writeRow <= 0) writeRow = (vals.length || 0) + 1;

  // Prepare writes
  const toStr = v => (v === undefined || v === null) ? '' : String(v);
  const toNum = v => (v === undefined || v === null || v === '') ? '' : Number(v);

  const data = [
    { range: `${sheetName}!A${writeRow}`, values: [[ toStr(date)      ]] },
    { range: `${sheetName}!C${writeRow}`, values: [[ toStr(bookie)    ]] },
    { range: `${sheetName}!D${writeRow}`, values: [[ toStr(sport)     ]] },
    { range: `${sheetName}!E${writeRow}`, values: [[ toStr(event)     ]] },
    { range: `${sheetName}!F${writeRow}`, values: [[ toStr(betText)   ]] },
    { range: `${sheetName}!G${writeRow}`, values: [[ toStr(settleDate)]] },
    { range: `${sheetName}!H${writeRow}`, values: [[ toNum(odds)      ]] },
    { range: `${sheetName}!I${writeRow}`, values: [[ toNum(fairOdds)  ]] },
    { range: `${sheetName}!N${writeRow}`, values: [[ toStr(bookieUrl) ]] }
  ];

  if (mappingJson !== undefined) {
    const json = typeof mappingJson === 'string' ? mappingJson : JSON.stringify(mappingJson);
    data.push({ range: `${sheetName}!X${writeRow}`, values: [[ json ]] });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data }
  });

  return { writeRow };
}

/**
 * Update result (col L) for a specific row number (1-based).
 * @param {number} rowNumber 1-based row index in Bet Tracker
 * @param {"W"|"L"|"V"|"P"} result
 */
async function updateBetTrackerResult(rowNumber, result, spreadsheetId, sheetName = 'Bet Tracker') {
  const sheets = await getSheetsClient();
  const sid = spreadsheetId || process.env.BET_TRACKER_SHEET_ID || DEFAULT_BET_TRACKER_SHEET_ID;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `${sheetName}!L${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ result ]] }
  });
}

/**
 * Update mapping JSON (col X) for a specific row number (1-based).
 */
async function updateBetTrackerMapping(rowNumber, mappingJson, spreadsheetId, sheetName = 'Bet Tracker') {
  const sheets = await getSheetsClient();
  const sid = spreadsheetId || process.env.BET_TRACKER_SHEET_ID || DEFAULT_BET_TRACKER_SHEET_ID;
  const json = typeof mappingJson === 'string' ? mappingJson : JSON.stringify(mappingJson);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `${sheetName}!X${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ json ]] }
  });
}

/**
 * Get pending rows (M = 'Y', L = 'P') that have mapping JSON in X.
 * Returns array of { rowNumber, date, sport, mapping, latestKO, marketIds }.
 */
async function getBetTrackerPendingWithMapping(spreadsheetId, sheetName = 'Bet Tracker') {
  const sheets = await getSheetsClient();
  const sid = spreadsheetId || process.env.BET_TRACKER_SHEET_ID || DEFAULT_BET_TRACKER_SHEET_ID;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sid,
    range: `${sheetName}!A:Z`
  });
  const rows = res.data.values || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const approved = (r[COL.APPROVED] || '').toUpperCase() === 'Y';
    const result = (r[COL.RESULT] || '').toUpperCase();
    const mapRaw = r[COL.MAP_JSON];
    if (!approved || result !== 'P' || !mapRaw) continue;
    let mapping = null;
    try { mapping = JSON.parse(mapRaw); } catch { continue; }
    const marketIds = (mapping.legs || []).map(l => l.bfMarketId).filter(Boolean);
    const latestKO = mapping.latestKO ? new Date(mapping.latestKO).toISOString() : null;
    out.push({ rowNumber: i + 1, date: r[COL.DATE], sport: r[COL.SPORT], mapping, latestKO, marketIds });
  }
  return out;
}

module.exports = {
  // MasterBets
  fetchAllMasterRows,
  fetchNewBets,
  markRowSend,
  // Bet Tracker
  appendToBetTrackerRow,
  updateBetTrackerResult,
  updateBetTrackerMapping,
  getBetTrackerPendingWithMapping,
  COL,
};