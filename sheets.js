// sheets.js
const { google } = require('googleapis');
const creds = require('./credentials.json');      // ← your service account key

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

/**
 * Fetch all rows from MasterBets, including header.
 */
async function fetchAllMasterRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'MasterBets!A:W'
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
  const body   = (all.slice(1) || []).filter(r => r[9] === 'S');
  return [header, ...body];
}

/**
 * Marks a given row’s Send-column cell to a new value.
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

module.exports = { fetchAllMasterRows, fetchNewBets, markRowSend };