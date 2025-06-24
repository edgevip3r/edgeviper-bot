// sheets.js
const { google } = require('googleapis');
const creds = require('./credentials.json');      // ← make sure you saved your JSON key here

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

async function fetchMasterRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'MasterBets!A:W'
  });
  return res.data.values || [];
}

module.exports = { fetchMasterRows };

/**
 * Marks a given row’s Send-column cell to a new value.
 * @param {number} rowIndex  0-based index into the fetched array (so +1 for sheet)
 * @param {string} newVal    the value to write (e.g. "P")
 */
async function markRowSend(rowIndex, newVal) {
  const sheets = await getSheetsClient();
  const sheetName = 'MasterBets';
  // Column J is the 10th column → "J"
  const colLetter = 'J';
  // rowIndex is 0 for header; actual sheet row is rowIndex+1
  const sheetRow = rowIndex + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${sheetName}!${colLetter}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ newVal ]] }
  });
}

module.exports = { fetchMasterRows, markRowSend };