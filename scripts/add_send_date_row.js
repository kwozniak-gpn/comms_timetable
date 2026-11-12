// scripts/add_send_date_row.js — one-time structural fix, discovered while building
// jobs/weekly-setup.js: GRN Template still has the OLD layout (Country / Who activated?
// / Build deadline / Status) — missing the "Send date" row and the "Submission
// deadline" rename that the already-live "GRN 09.11.26" tab has (someone added these
// by hand after that tab was created from an older template, so the template drifted
// out of sync with its own output). weekly-setup.js's Send-date prefill has nowhere to
// write without this row existing in the template first.
//
// Per block, bottom-to-top (so each block's original row numbers stay valid — nothing
// above an unprocessed block is ever touched before it's this block's turn):
//   1. Insert one blank row right where "Build deadline" currently is.
//   2. Label the newly-blank row "Send date".
//   3. Rename the (now shifted down by 1) old "Build deadline" row to "Submission deadline".
//
// Usage: node scripts/add_send_date_row.js <TAB_NAME> [--apply]  (dry run by default)
require('dotenv').config();
const sheets = require('../lib/sheets_rest');
const { parseDayBlocks } = require('../lib/timetable_parser');
const { getAccessToken } = require('../lib/gcp_access_token');

const TIMETABLE_SPREADSHEET_ID = process.env.TIMETABLE_SPREADSHEET_ID || '1Js1-99MwrN-klxlh23FIzgZSLUhyxQEz62AyBd2HzPw';

async function fetchGrid(tabName) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TIMETABLE_SPREADSHEET_ID}?ranges=${encodeURIComponent(`'${tabName}'!A1:AB400`)}&fields=sheets.data.rowData.values(formattedValue,hyperlink)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`fetchGrid failed: ${res.status} ${await res.text()}`);
  const { sheets: sheetsData } = await res.json();
  return sheetsData[0].data[0].rowData || [];
}

async function getSheetId(tabName) {
  const meta = await sheets.getSheetMeta(TIMETABLE_SPREADSHEET_ID);
  const found = meta.find((m) => m.title === tabName);
  if (!found) throw new Error(`Tab "${tabName}" not found`);
  return found.sheetId;
}

async function main() {
  const tabName = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!tabName) {
    console.error('Usage: node scripts/add_send_date_row.js <TAB_NAME> [--apply]');
    process.exit(1);
  }

  const rowData = await fetchGrid(tabName);
  const blocks = parseDayBlocks(rowData);

  const needsFix = blocks.filter((b) => !b.fields['Send date'] && b.fields['Build deadline']);
  console.log(`Tab "${tabName}": ${blocks.length} blocks, ${needsFix.length} need the Send date row inserted.`);
  needsFix.forEach((b) => console.log(`  ${b.dayName} ${b.dateRaw} — Build deadline currently at row ${b.fields['Build deadline'].rowNumber}`));

  if (!apply) {
    console.log('\nDry run only — pass --apply to execute.');
    return;
  }

  const sheetId = await getSheetId(tabName);
  // Bottom-to-top: highest row number first, so an unprocessed block's row numbers
  // (still the ORIGINAL ones from the single fetch above) are never invalidated by an
  // insertion that happened in a block below it.
  const ordered = [...needsFix].sort((a, b2) => b2.fields['Build deadline'].rowNumber - a.fields['Build deadline'].rowNumber);

  for (const block of ordered) {
    const buildDeadlineRow = block.fields['Build deadline'].rowNumber;
    await sheets.batchUpdate(TIMETABLE_SPREADSHEET_ID, [{
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: buildDeadlineRow - 1, endIndex: buildDeadlineRow },
        inheritFromBefore: false,
      },
    }]);
    await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, `${sheets.quoteSheetTitle(tabName)}!A${buildDeadlineRow}`, [['Send date']]);
    await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, `${sheets.quoteSheetTitle(tabName)}!A${buildDeadlineRow + 1}`, [['Submission deadline']]);
    console.log(`  fixed block ${block.dayName} ${block.dateRaw}: inserted Send date at row ${buildDeadlineRow}, Submission deadline now at row ${buildDeadlineRow + 1}`);
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
