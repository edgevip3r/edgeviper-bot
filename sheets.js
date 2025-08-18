// File: sheets.js
const { google } = require('googleapis');
let sheetsClient;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

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
 *
 * IMPORTANT: This preserves your original behaviour exactly
 * (fixed J column = index 9, no header sniffing).
 */
async function fetchNewBets() {
  const all = await fetchAllMasterRows();
  const header = all[0] || [];
  const body   = (all.slice(1) || []).filter(r => r && r[9] === 'S');
  return [header, ...body];
}

/**
 * Marks a given MasterBets row index (1-based in Google Sheets UI) as sent with value newVal.
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

module.exports = { fetchAllMasterRows, fetchNewBets, markRowSend };