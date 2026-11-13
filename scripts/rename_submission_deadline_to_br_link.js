// scripts/rename_submission_deadline_to_br_link.js — one-time edit, Hannah's ask via
// Kasia (13 Nov 2026): "Submission deadline" is dead weight from the old workflow
// (stale weekday text, nothing reads or writes it) — replace it with "BR Link", which
// jobs/status-poller.js now populates with each country's real Bloomreach scenario
// link (clickable), the same scenarioLink value it already reads for the 🔓 check.
//
// Renames the row label and clears its stale weekday values (the row becomes purely
// machine-written going forward — no human content to preserve).
//
// Usage: node scripts/rename_submission_deadline_to_br_link.js <TAB_NAME> [--apply]
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

async function main() {
  const tabName = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!tabName) {
    console.error('Usage: node scripts/rename_submission_deadline_to_br_link.js <TAB_NAME> [--apply]');
    process.exit(1);
  }

  const rowData = await fetchGrid(tabName);
  const blocks = parseDayBlocks(rowData);
  const targets = blocks.filter((b) => b.fields['Submission deadline']);

  console.log(`Tab "${tabName}": ${targets.length} "Submission deadline" rows to rename -> "BR Link".`);
  targets.forEach((b) => {
    const f = b.fields['Submission deadline'];
    const values = f.cells.slice(1).map((c) => c.text).filter(Boolean);
    console.log(`  ${b.dayName} ${b.dateRaw} — row ${f.rowNumber}, clearing: [${values.join(', ')}]`);
  });

  if (!apply) {
    console.log('\nDry run only — pass --apply to execute.');
    return;
  }

  for (const block of targets) {
    const f = block.fields['Submission deadline'];
    const width = f.cells.length;
    const range = `${sheets.quoteSheetTitle(tabName)}!A${f.rowNumber}:${sheets.colLetter(width)}${f.rowNumber}`;
    const row = ['BR Link', ...new Array(width - 1).fill('')];
    await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, range, [row]);
    console.log(`  renamed row ${f.rowNumber} -> "BR Link" (cleared)`);
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
