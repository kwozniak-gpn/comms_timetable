// scripts/one_time_template_edits.js — Part 1 of the plan: one-time edits to the
// GRN Template / VC Template tabs (+ the already-live GRN 09.11.26 tab, per Kasia's
// "only adjust the 09.11.26" instruction). NOT scheduled, NOT run by any Cloud Run
// Job — run once by hand, dry-run first.
//
// What this does, per day-block within a tab:
//   - GRN only: delete the "Newsletter Name" row and the "Preflight sent?" row.
//   - Rename "Who's building?" -> "Who activated?" (GRN + VC).
//   - GRN only: rename the Asana row -> "Status". Naming drift confirmed live: the
//     TEMPLATE tab spells it "Added to implementation tracker?"; the already-created
//     "GRN 09.11.26" tab spells it "Asana submitted?" — both are matched.
//   - GRN only: rewrite each Country-row cell's hyperlink from the retired exposure
//     calendar it currently points to, to that country's real current tracking sheet
//     (COUNTRY_SHEET_LINKS below — IDs confirmed live from each repo's own
//     country_config.js / this project's own memory, not guessed).
//
// Usage:
//   node scripts/one_time_template_edits.js <TAB_NAME> [--apply]
// Default is a dry run — prints the full plan (every row to delete/rename, every
// hyperlink to rewrite) without writing anything. Pass --apply to actually execute.
// ALWAYS run against a disposable test-copy tab first (e.g. "Copy of GRN 09.11.26")
// before ever pointing this at "GRN Template"/"VC Template"/"GRN 09.11.26" themselves.
require('dotenv').config();
const sheets = require('../lib/sheets_rest');

const TIMETABLE_SPREADSHEET_ID = process.env.TIMETABLE_SPREADSHEET_ID || '1Js1-99MwrN-klxlh23FIzgZSLUhyxQEz62AyBd2HzPw';

// Real current tracking-sheet IDs, confirmed live (10 Nov 2026):
//   - UK Dates tab, NA Sends tab: from project_comms_status_dashboard_design memory.
//   - Every ROW + UAE country: row_newsletter_automation/lib/country_config.js's own
//     NEW_SENDS_SHEET_ID map — the authoritative, current source, not a stale memory
//     snapshot.
const COUNTRY_SHEET_LINKS = {
  UK: 'https://docs.google.com/spreadsheets/d/1Q6Pl3Z3KVJBfX4HPBElZ7ENDybC5kWS9YhwKFMeBLTU/edit',
  NA: 'https://docs.google.com/spreadsheets/d/1nRf73lrKp-8WuyIjiwwSde_9hvdVzxsQYxPrXAaurNI/edit',
  'NA CO': 'https://docs.google.com/spreadsheets/d/1nRf73lrKp-8WuyIjiwwSde_9hvdVzxsQYxPrXAaurNI/edit',
  'NA CW': 'https://docs.google.com/spreadsheets/d/1nRf73lrKp-8WuyIjiwwSde_9hvdVzxsQYxPrXAaurNI/edit',
  AU: 'https://docs.google.com/spreadsheets/d/1dl1TIfEBvsH6r3UHQkBWECJSXaK8N7crz9nZLqUv0mU/edit',
  DE: 'https://docs.google.com/spreadsheets/d/1P8gHeB1O6ICz1hy12-0z0AEZE71JjPAwb8v6cJH1Zb0/edit',
  FR: 'https://docs.google.com/spreadsheets/d/1p66TnNUpkAeCW1aN--SVN8FbRecSJ2i8ZwiF-Wvb-S8/edit',
  IE: 'https://docs.google.com/spreadsheets/d/1ajxWFWEvJf_iEsDVMCCg8lwAzZR_hnm-nwNNXZjBeTA/edit',
  IT: 'https://docs.google.com/spreadsheets/d/1i1vUoMGyDs0CpNNykzAd-cWPo2NMCj4o2Wb-SCWC9uk/edit',
  NL: 'https://docs.google.com/spreadsheets/d/1DAdZrnFmbCmyHsZn-O3SOZJZ7E314SJOl7YBgM47eS0/edit',
  PL: 'https://docs.google.com/spreadsheets/d/1SD78TigKLJOjl9t3ZKdMApu9M5UZNP4ft0tYlKYQTOA/edit',
  ES: 'https://docs.google.com/spreadsheets/d/1HLuLXVU5u0LAhJ8TI1a56FBCKcef2shNLnjRPY0Z3Q4/edit',
  UAE: 'https://docs.google.com/spreadsheets/d/1nOqLoUcaf9BpcybrSk9oooCSCjo0QUrX2ciBO0X4qD0/edit',
};

const ASANA_ROW_LABELS = ['Added to implementation tracker?', 'Asana submitted?'];

function norm(s) {
  return (s || '').trim();
}

// Fetches the tab's grid with formattedValue + hyperlink (needed to both read current
// labels/links and know exactly which cell to rewrite). Returns rowData as returned by
// the Sheets API (1 entry per row, possibly sparse).
async function fetchGrid(tabName) {
  const token = await require('../lib/gcp_access_token').getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TIMETABLE_SPREADSHEET_ID}?ranges=${encodeURIComponent(`'${tabName}'!A1:AB400`)}&fields=sheets.data.rowData.values(formattedValue,hyperlink)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`fetchGrid failed: ${res.status} ${await res.text()}`);
  const { sheets: sheetsData } = await res.json();
  return sheetsData[0].data[0].rowData || [];
}

// Builds the edit plan: for every "Country" row found, look at the rows immediately
// below/above it (same day-block) for the labels we care about. A day-block's row
// order is fixed by construction (Country, Newsletter Name, Who's building?, Build
// deadline/Send date, Preflight sent?, Submission deadline, Asana row) but we match by
// LABEL TEXT, never by a fixed offset — a block missing a row (VC has no Asana/Preflight
// rows at all) must not misfire.
function buildPlan(rowData, { isGrn }) {
  const rows = rowData.map((r, i) => ({
    rowNumber: i + 1,
    cells: (r.values || []).map((v) => ({ text: norm(v.formattedValue), hyperlink: v.hyperlink || null })),
  }));

  const deleteRows = [];
  const renames = []; // { rowNumber, newLabel }
  const hyperlinkFixes = []; // { rowNumber, colIndex (0-based), countryCode, url }

  for (const row of rows) {
    const label = row.cells[0]?.text || '';
    if (isGrn && label === 'Newsletter Name') deleteRows.push(row.rowNumber);
    if (isGrn && label === 'Preflight sent?') deleteRows.push(row.rowNumber);
    if (label === "Who's building?") renames.push({ rowNumber: row.rowNumber, newLabel: 'Who activated?' });
    if (isGrn && ASANA_ROW_LABELS.includes(label)) renames.push({ rowNumber: row.rowNumber, newLabel: 'Status' });

    if (isGrn && label === 'Country') {
      row.cells.forEach((cell, colIndex) => {
        if (colIndex === 0) return; // the "Country" label cell itself
        const code = cell.text;
        if (!code) return;
        const target = COUNTRY_SHEET_LINKS[code];
        if (!target) {
          console.warn(`  (!) no known tracking-sheet link for country code "${code}" at row ${row.rowNumber} col ${colIndex + 1} — leaving untouched`);
          return;
        }
        if (cell.hyperlink === target) return; // already correct, nothing to do
        hyperlinkFixes.push({ rowNumber: row.rowNumber, colIndex, countryCode: code, currentUrl: cell.hyperlink, newUrl: target });
      });
    }
  }

  return { deleteRows, renames, hyperlinkFixes };
}

async function getSheetId(tabName) {
  const meta = await sheets.getSheetMeta(TIMETABLE_SPREADSHEET_ID);
  const found = meta.find((m) => m.title === tabName);
  if (!found) throw new Error(`Tab "${tabName}" not found in the Timetable spreadsheet`);
  return found.sheetId;
}

async function main() {
  const tabName = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!tabName) {
    console.error('Usage: node scripts/one_time_template_edits.js <TAB_NAME> [--apply]');
    process.exit(1);
  }
  const isGrn = tabName.startsWith('GRN') || tabName.includes('GRN');

  const rowData = await fetchGrid(tabName);
  const plan = buildPlan(rowData, { isGrn });

  console.log(`\nPlan for tab "${tabName}" (isGrn=${isGrn}):`);
  console.log(`  Rows to delete (${plan.deleteRows.length}):`, plan.deleteRows);
  console.log(`  Label renames (${plan.renames.length}):`);
  plan.renames.forEach((r) => console.log(`    row ${r.rowNumber} -> "${r.newLabel}"`));
  console.log(`  Hyperlink fixes (${plan.hyperlinkFixes.length}):`);
  plan.hyperlinkFixes.forEach((h) => console.log(`    row ${h.rowNumber} col ${h.colIndex + 1} (${h.countryCode}): ${h.currentUrl || '(none)'} -> ${h.newUrl}`));

  if (!apply) {
    console.log('\nDry run only — pass --apply to execute.');
    return;
  }

  // 1. Hyperlink fixes — USER_ENTERED so the HYPERLINK() formula is actually parsed,
  //    not stored as a literal string.
  for (const h of plan.hyperlinkFixes) {
    const range = `${sheets.quoteSheetTitle(tabName)}!${sheets.colLetter(h.colIndex + 1)}${h.rowNumber}`;
    await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, range, [[`=HYPERLINK("${h.newUrl}","${h.countryCode}")`]], { valueInputOption: 'USER_ENTERED' });
    console.log(`  fixed hyperlink: ${range}`);
  }

  // 2. Label renames — plain cell writes, no row-shift risk.
  for (const r of plan.renames) {
    const range = `${sheets.quoteSheetTitle(tabName)}!A${r.rowNumber}`;
    await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, range, [[r.newLabel]]);
    console.log(`  renamed: ${range} -> "${r.newLabel}"`);
  }

  // 3. Row deletions — single batchUpdate, ordered HIGHEST row index first so earlier
  //    deletions in this same call never invalidate a later request's row index.
  if (plan.deleteRows.length) {
    const sheetId = await getSheetId(tabName);
    const requests = [...plan.deleteRows].sort((a, b) => b - a).map((rowNumber) => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
      },
    }));
    await sheets.batchUpdate(TIMETABLE_SPREADSHEET_ID, requests);
    console.log(`  deleted ${requests.length} rows`);
  }

  console.log('\nDone.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
