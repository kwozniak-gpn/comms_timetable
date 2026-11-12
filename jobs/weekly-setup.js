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
const { getSendDateForCountry } = require('../lib/bf_cm_overrides');
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

// Remaps every day-block's date (col B of the day-row) to the real target week.
// Blocks in the template are already consecutive calendar days, in order (verified
// against real data) — anchor whichever block is labeled "Monday" to the real target
// Monday, then every other block = anchor + (its own position offset from that block).
async function remapBlockDates(tabName, targetMonday) {
  const rowData = await fetchGrid(tabName);
  const blocks = parseDayBlocks(rowData);
  const mondayIdx = blocks.findIndex((b) => b.dayName === 'Monday');
  if (mondayIdx === -1) throw new Error(`remapBlockDates: no "Monday" block found in ${tabName} — can't anchor the week`);

  for (let i = 0; i < blocks.length; i++) {
    const offsetDays = i - mondayIdx;
    const date = new Date(targetMonday);
    date.setUTCDate(date.getUTCDate() + offsetDays);
    const range = `${sheets.quoteSheetTitle(tabName)}!B${blocks[i].dayRowNumber}`;
    await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, range, [[blockDateCell(date)]]);
    console.log(`    ${tabName} row ${blocks[i].dayRowNumber} (${blocks[i].dayName}) -> ${blockDateCell(date)}`);
  }
  // Return the blocks re-annotated with their real build dates for the caller.
  return blocks.map((b, i) => {
    const date = new Date(targetMonday);
    date.setUTCDate(date.getUTCDate() + (i - mondayIdx));
    return { ...b, buildDateIso: date.toISOString().slice(0, 10) };
  });
}

// GRN only: for each block, for each country column, compute the real upcoming Send
// date via getSendDateForCountry(countryCode, buildDate). Repeated country codes within
// the SAME block (NA CO/NA CW staging several upcoming sends in one block, confirmed in
// real live data) advance a per-code cursor so each repeat gets the NEXT date after the
// previous one, not the same date three times.
async function prefillGrnSendDates(tabName, blocks) {
  for (const block of blocks) {
    const sendDateField = block.fields['Send date'];
    if (!sendDateField) {
      console.warn(`    (!) ${tabName} block ${block.dayName} has no "Send date" row — skipping`);
      continue;
    }
    const cols = countryColumns(block);
    const cursor = {}; // countryCode -> last-used date ISO, to advance repeats
    for (const { code: rawCode, colIndex } of cols) {
      const code = resolveCountryCode(rawCode, block.dayName);
      if (rawCode === 'NA') console.log(`    (resolved bare "NA" -> "${code}" for ${block.dayName} block, col ${colIndex + 1})`);
      let fromDate = block.buildDateIso;
      if (cursor[code]) {
        const d = new Date(`${cursor[code]}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        fromDate = d.toISOString().slice(0, 10);
      }
      let result;
      try {
        result = getSendDateForCountry(code, new Date(`${fromDate}T00:00:00Z`));
      } catch (err) {
        console.warn(`    (!) ${tabName} block ${block.dayName} col ${colIndex + 1}: ${err.message}`);
        continue;
      }
      cursor[code] = result.dateIso;
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
