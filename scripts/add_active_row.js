// scripts/add_active_row.js — one-time structural addition, Kasia's explicit ask
// (12 Nov 2026): add an "Active?" row to every GRN day-block, hand-filled by Hannah/
// Kasia when they click Activate in Bloomreach. Distinct from "Who activated?" (who did
// it) and "Status" (machine-derived state) — this is a plain human-ticked completion
// flag. GRN only — VC has no Bloomreach activation step yet (deferred to the post-Dec-1
// migration, same boundary as the rest of this project).
//
// Inserted right after "Status" in each block, same bottom-to-top insertDimension
// discipline as scripts/add_send_date_row.js (so each block's original row numbers from
// the single initial fetch stay valid throughout).
//
// Usage: node scripts/add_active_row.js <TAB_NAME> [--apply]  (dry run by default)
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
    console.error('Usage: node scripts/add_active_row.js <TAB_NAME> [--apply]');
    process.exit(1);
  }

  const rowData = await fetchGrid(tabName);
  const blocks = parseDayBlocks(rowData);
  const needsFix = blocks.filter((b) => !b.fields['Active?'] && b.fields.Status);

  console.log(`Tab "${tabName}": ${blocks.length} blocks, ${needsFix.length} need "Active?" inserted.`);
  needsFix.forEach((b) => console.log(`  ${b.dayName} ${b.dateRaw} — Status currently at row ${b.fields.Status.rowNumber}`));

  if (!apply) {
    console.log('\nDry run only — pass --apply to execute.');
    return;
  }

  const sheetId = await getSheetId(tabName);
  const ordered = [...needsFix].sort((a, b2) => b2.fields.Status.rowNumber - a.fields.Status.rowNumber);

  for (const block of ordered) {
    const statusRow = block.fields.Status.rowNumber;
    const insertAt = statusRow + 1; // right after Status
    await sheets.batchUpdate(TIMETABLE_SPREADSHEET_ID, [{
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: insertAt - 1, endIndex: insertAt },
        inheritFromBefore: false,
      },
    }]);
    await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, `${sheets.quoteSheetTitle(tabName)}!A${insertAt}`, [['Active?']]);
    console.log(`  fixed block ${block.dayName} ${block.dateRaw}: inserted "Active?" at row ${insertAt}`);
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
