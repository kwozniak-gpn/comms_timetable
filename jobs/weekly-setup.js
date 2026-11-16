// jobs/weekly-setup.js — Part 2 of the plan: Monday Cloud Run Job. Replaces Hannah's
// Apps Script createWeeklyTabs entirely (she's been looped in, per Kasia). For each of
// GRN/VC: duplicates the (now-cleaned) Template tab into this week's real tab if it
// doesn't already exist (idempotent), remaps every day-block's date to the real current
// week, and — new capability — prefills GRN's Send date per country and backfills VC's
// recurring-send fields where the template's own inherited values are missing.
//
// Never touches any tab except the current week's new one (confirmed scope — no
// retroactive edits to past weeks).
require('dotenv').config();
const sheets = require('../lib/sheets_rest');
const { getAccessToken } = require('../lib/gcp_access_token');
const { parseDayBlocks, countryColumns, resolveCountryCode } = require('../lib/timetable_parser');
const { GRN_BUILD_SCHEDULE, applyBfCmOverride } = require('../lib/bf_cm_overrides');
const { VC_RECURRING_SENDS } = require('../lib/vc_template');

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

function pad2(n) { return String(n).padStart(2, '0'); }

// "09.11.26" — matches the existing tab-name convention exactly.
function tabDateSuffix(date) {
  return `${pad2(date.getUTCDate())}.${pad2(date.getUTCMonth() + 1)}.${String(date.getUTCFullYear()).slice(-2)}`;
}
// "09/11/2026" — matches the existing day-block date-cell convention.
function blockDateCell(date) {
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}
// "12.11.26" — matches the existing "Weekday: DD.MM.YY" Send-date cell convention.
function sendDateSuffix(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${String(d.getUTCFullYear()).slice(-2)}`;
}

function mondayOnOrAfter(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

async function getSheetId(tabName) {
  const meta = await sheets.getSheetMeta(TIMETABLE_SPREADSHEET_ID);
  const found = meta.find((m) => m.title === tabName);
  return found ? found.sheetId : null;
}

// Creates the week's tab from its template if it doesn't already exist. Returns the
// new (or already-existing) tab name — idempotent, safe to call every run.
async function ensureWeekTab(templateName, weekDateSuffix) {
  const newTitle = `${templateName.replace(' Template', '')} ${weekDateSuffix}`;
  const meta = await sheets.getSheetMeta(TIMETABLE_SPREADSHEET_ID);
  if (meta.some((m) => m.title === newTitle)) {
    console.log(`  ${newTitle} already exists — skipping creation (idempotent).`);
    return { title: newTitle, created: false };
  }
  const tpl = meta.find((m) => m.title === templateName);
  if (!tpl) throw new Error(`Template tab "${templateName}" not found`);
  await sheets.duplicateSheet(TIMETABLE_SPREADSHEET_ID, tpl.sheetId, newTitle, tpl.index + 1);
  console.log(`  created ${newTitle} from ${templateName}`);
  return { title: newTitle, created: true };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Each block's real date is its own weekday's distance from the target Monday (0-6),
// independent of the block's row position. This matters because VC's blocks are NOT
// simple consecutive-forward days: its trailing "Monday" block (Rewards/IE Rewards,
// confirmed real content in both GRN 09.11.26 and this week) sits at the BOTTOM of the
// row order but belongs to the SAME week's Monday, not the next one — verified against
// VC 09.11.26 where that block is dated 09/11/2026, matching that week's own Monday, not
// 16/11/2026. A position-based "anchor block 0, then +1 per row" scheme gets this one
// wrong by a full week. GRN's blocks happen to already run Monday->Friday in row order,
// so this formula reduces to the same dates there.
function dayOffsetFromMonday(dayName) {
  const idx = DAY_NAMES.indexOf(dayName);
  if (idx === -1) throw new Error(`dayOffsetFromMonday: unrecognized day name "${dayName}"`);
  return (idx - 1 + 7) % 7; // Monday(1) -> 0, Tuesday(2) -> 1, ... Sunday(0) -> 6
}

// Remaps every day-block's date (col B of the day-row) to the real target week, each
// computed independently from the block's own day name (see dayOffsetFromMonday).
async function remapBlockDates(tabName, targetMonday) {
  const rowData = await fetchGrid(tabName);
  const blocks = parseDayBlocks(rowData);
  if (blocks.length === 0) throw new Error(`remapBlockDates: no day blocks found in ${tabName}`);

  const blockDate = (dayName) => {
    const d = new Date(targetMonday);
    d.setUTCDate(d.getUTCDate() + dayOffsetFromMonday(dayName));
    return d;
  };

  for (const block of blocks) {
    const date = blockDate(block.dayName);
    const range = `${sheets.quoteSheetTitle(tabName)}!B${block.dayRowNumber}`;
    await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, range, [[blockDateCell(date)]]);
    console.log(`    ${tabName} row ${block.dayRowNumber} (${block.dayName}) -> ${blockDateCell(date)}`);
  }
  // Week Commencing Date cell (row 2) always reflects the tab's own first block date —
  // matches the existing human convention (GRN's is the real Monday; VC's is its own
  // first block, Tuesday).
  const wcDate = blockDate(blocks[0].dayName);
  await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, `${sheets.quoteSheetTitle(tabName)}!B2`, [[blockDateCell(wcDate)]]);
  console.log(`    ${tabName} Week Commencing Date -> ${blockDateCell(wcDate)}`);

  // Return the blocks re-annotated with their real build dates for the caller.
  return blocks.map((b) => {
    const date = blockDate(b.dayName);
    return { ...b, buildDateIso: date.toISOString().slice(0, 10) };
  });
}

// GRN only: for each block, for each country column, compute the real Send date from
// GRN_BUILD_SCHEDULE's fixed day-offset for that (build day, column position) — see the
// table's own comment for why this can't be a generic "next occurrence of the country's
// weekly send day" scan. Matched by column position against the schedule, not by country
// code lookup, since NA CO repeats multiple times per block with different offsets.
async function prefillGrnSendDates(tabName, blocks) {
  for (const block of blocks) {
    const sendDateField = block.fields['Send date'];
    if (!sendDateField) {
      console.warn(`    (!) ${tabName} block ${block.dayName} has no "Send date" row — skipping`);
      continue;
    }
    const schedule = GRN_BUILD_SCHEDULE[block.dayName];
    if (!schedule) {
      console.warn(`    (!) ${tabName} block ${block.dayName}: no GRN_BUILD_SCHEDULE entry — skipping`);
      continue;
    }
    const cols = countryColumns(block);
    for (let i = 0; i < cols.length; i++) {
      const { code: rawCode, colIndex } = cols[i];
      const code = resolveCountryCode(rawCode, block.dayName);
      const entry = schedule[i];
      if (!entry || entry.country !== code) {
        console.warn(`    (!) ${tabName} block ${block.dayName} col ${colIndex + 1}: expected "${entry && entry.country}" at position ${i}, found "${code}" — skipping (Country row doesn't match GRN_BUILD_SCHEDULE's expected order)`);
        continue;
      }
      const d = new Date(`${block.buildDateIso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + entry.offsetDays);
      const result = applyBfCmOverride(code, d.toISOString().slice(0, 10));
      const cellText = `${result.day}: ${sendDateSuffix(result.dateIso)}`;
      const range = `${sheets.quoteSheetTitle(tabName)}!${sheets.colLetter(colIndex + 1)}${sendDateField.rowNumber}`;
      // Never overwrite an already-filled Send date (a human may have corrected it,
      // or an earlier run already filled it) — read-check-write, not blind.
      const [existing] = await sheets.readRange(TIMETABLE_SPREADSHEET_ID, range);
      if (existing && existing[0]) {
        console.log(`    ${tabName} ${code} Send date already set (${existing[0]}) — leaving as-is`);
        continue;
      }
      await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, range, [[cellText]]);
      console.log(`    ${tabName} ${code} Send date -> ${cellText}`);
    }
  }
}

// VC only: for each block, for each newsletter-name column, backfill any blank
// Segment name/Segment size/Schedule time/Exceed-messaging field from
// VC_RECURRING_SENDS — never overwrites an already-populated cell (the template's own
// inherited values are the source of truth; this is a safety net, not a forced reset).
async function backfillVcRecurring(tabName, blocks) {
  for (const block of blocks) {
    const newsletterField = block.fields['Newsletter name'];
    if (!newsletterField) continue;
    for (let colIndex = 0; colIndex < newsletterField.cells.length; colIndex++) {
      const cell = newsletterField.cells[colIndex];
      if (colIndex === 0 || !cell.text) continue;
      const match = VC_RECURRING_SENDS.find((s) => s.newsletterName === cell.text && s.day === block.dayName);
      if (!match) continue;
      const fieldMap = {
        'Segment name': match.segmentName,
        'Segment size': match.segmentSize,
        'Schedule time (Please schedule from 7:30am onwards)': match.scheduleTime,
        "Select 'yes' on exceed messaging drop down box?": match.exceedMessaging,
      };
      for (const [label, value] of Object.entries(fieldMap)) {
        const field = block.fields[label];
        if (!field || !value) continue;
        const existingCell = field.cells[colIndex];
        if (existingCell && existingCell.text) continue; // already populated, leave it
        const range = `${sheets.quoteSheetTitle(tabName)}!${sheets.colLetter(colIndex + 1)}${field.rowNumber}`;
        await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, range, [[value]]);
        console.log(`    ${tabName} ${match.newsletterName} (${block.dayName}) ${label} -> ${value}`);
      }
    }
  }
}

async function main() {
  const targetMonday = mondayOnOrAfter(new Date());
  const weekSuffix = tabDateSuffix(targetMonday);
  console.log(`weekly-setup: target week commencing ${blockDateCell(targetMonday)} (suffix ${weekSuffix})`);

  const grn = await ensureWeekTab('GRN Template', weekSuffix);
  const grnBlocks = await remapBlockDates(grn.title, targetMonday);
  await prefillGrnSendDates(grn.title, grnBlocks);

  const vc = await ensureWeekTab('VC Template', weekSuffix);
  const vcBlocks = await remapBlockDates(vc.title, targetMonday);
  await backfillVcRecurring(vc.title, vcBlocks);

  console.log('weekly-setup: done.');
}

module.exports = {
  mondayOnOrAfter, tabDateSuffix, blockDateCell, sendDateSuffix,
  ensureWeekTab, remapBlockDates, prefillGrnSendDates, backfillVcRecurring, main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
