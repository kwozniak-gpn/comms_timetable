// lib/sheets_rest.js — generic Google Sheets REST wrapper, plain fetch() + ADC, no
// googleapis dependency — same house pattern as na_newsletter_automation/lib/
// tracking_sheet_rest.js and row_newsletter_automation/lib/sends_tab_rest.js, but
// generalized to take a spreadsheetId per call instead of hardcoding one, since this
// repo reads/writes across multiple spreadsheets (the Timetable sheet itself, plus a
// read-only cross-reference into each of NA/UK/ROW's own Sends tracking sheets).
const { getAccessToken } = require('./gcp_access_token');

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function quoteSheetTitle(title) {
  // Tab titles routinely contain spaces/dots ("GRN 09.11.26") — always quote, matching
  // the convention every sibling repo already uses for its own per-date tabs.
  return `'${title.replace(/'/g, "''")}'`;
}

async function authHeaders(extra = {}) {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}`, ...extra };
}

// Returns every tab's {title, sheetId, index} for a spreadsheet — used to resolve a
// tab name to its real sheetId (needed for duplicateSheet/batchUpdate requests) and to
// find the set of existing week tabs (e.g. every "GRN DD.MM.YY" title) without guessing.
async function getSheetMeta(spreadsheetId) {
  const headers = await authHeaders();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers },
  );
  if (!res.ok) throw new Error(`Sheets metadata fetch failed: ${res.status} ${await res.text()}`);
  const { sheets } = await res.json();
  return sheets.map((s) => s.properties);
}

async function readRange(spreadsheetId, range) {
  const headers = await authHeaders();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers },
  );
  if (!res.ok) throw new Error(`Sheets read ${range} failed: ${res.status} ${await res.text()}`);
  const { values = [] } = await res.json();
  return values;
}

async function writeRange(spreadsheetId, range, values, { valueInputOption = 'RAW' } = {}) {
  const headers = await authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`,
    { method: 'PUT', headers, body: JSON.stringify({ values }) },
  );
  if (!res.ok) throw new Error(`Sheets write ${range} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function appendRange(spreadsheetId, range, values, { valueInputOption = 'RAW' } = {}) {
  const headers = await authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers, body: JSON.stringify({ values }) },
  );
  if (!res.ok) throw new Error(`Sheets append ${range} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function clearRange(spreadsheetId, range) {
  const headers = await authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', headers, body: '{}' },
  );
  if (!res.ok) throw new Error(`Sheets clear ${range} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function batchUpdate(spreadsheetId, requests) {
  const headers = await authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    { method: 'POST', headers, body: JSON.stringify({ requests }) },
  );
  if (!res.ok) throw new Error(`Sheets batchUpdate failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Duplicates an existing tab (by its real sheetId, not title — resolve via
// getSheetMeta first) to a new title at a given tab index. Returns the new sheetId.
// Used by jobs/weekly-setup.js to clone GRN Template/VC Template into the current
// week's tab, same mechanism Hannah's Apps Script createTabFromTemplate used, just via
// the REST API instead of Apps Script.
async function duplicateSheet(spreadsheetId, sourceSheetId, newTitle, insertIndex) {
  const { replies } = await batchUpdate(spreadsheetId, [
    { duplicateSheet: { sourceSheetId, insertSheetIndex: insertIndex, newSheetName: newTitle } },
  ]);
  return replies[0].duplicateSheet.properties.sheetId;
}

// Read-merge-write discipline for a single row range, keyed by a header array — same
// fix every sibling repo needed after a real incident where a partial write wiped
// unrelated columns (na_newsletter_automation/lib/tracking_sheet_rest.js's
// writeSendTabRow, 28 Oct 2026). `header` is the ordered list of field names for the
// row's columns (A.. onward); `fields` is a partial {name: value} patch.
async function writeRowMerged(spreadsheetId, sheetTitle, rowNumber, header, fields) {
  const range = `${quoteSheetTitle(sheetTitle)}!A${rowNumber}:${colLetter(header.length)}${rowNumber}`;
  const [existingValues = []] = await readRange(spreadsheetId, range).then((v) => v);
  const existing = {};
  header.forEach((h, i) => { existing[h] = existingValues[i] ?? ''; });
  const merged = { ...existing, ...fields };
  const row = header.map((h) => merged[h] ?? '');
  await writeRange(spreadsheetId, range, [row]);
}

// Sets cell-level formatting (alignment/wrap/etc.) via a repeatCell batchUpdate —
// values.update (writeRange) only ever touches cell VALUES, never formatting. Used by
// jobs/status-poller.js to keep the Status column left-aligned and non-wrapping
// (Kasia's explicit ask — long Notes-derived text must clip, never expand the row).
async function setCellFormat(spreadsheetId, sheetId, rowIndex0, colIndex0, format) {
  const fields = Object.keys(format).map((k) => `userEnteredFormat.${k}`).join(',');
  await batchUpdate(spreadsheetId, [{
    repeatCell: {
      range: {
        sheetId, startRowIndex: rowIndex0, endRowIndex: rowIndex0 + 1,
        startColumnIndex: colIndex0, endColumnIndex: colIndex0 + 1,
      },
      cell: { userEnteredFormat: format },
      fields,
    },
  }]);
}

// Same as setCellFormat but across a whole row's column range in one call — used to
// match an inserted row's styling to an existing row (e.g. "Active?" matching "Status").
async function setRowFormat(spreadsheetId, sheetId, rowIndex0, startCol0, endCol0, format) {
  const fields = Object.keys(format).map((k) => `userEnteredFormat.${k}`).join(',');
  await batchUpdate(spreadsheetId, [{
    repeatCell: {
      range: {
        sheetId, startRowIndex: rowIndex0, endRowIndex: rowIndex0 + 1,
        startColumnIndex: startCol0, endColumnIndex: endCol0,
      },
      cell: { userEnteredFormat: format },
      fields,
    },
  }]);
}

module.exports = {
  colLetter, quoteSheetTitle,
  getSheetMeta, readRange, writeRange, appendRange, clearRange, batchUpdate,
  duplicateSheet, writeRowMerged, setCellFormat, setRowFormat,
};
