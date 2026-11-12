// jobs/status-poller.js — Part 3 of the plan: runs every 30 min. Reads each country
// column's own Send date off the current/future GRN week tab(s), cross-references into
// that country's own NA/UK/ROW tracking sheet (already written by the reply-loop
// automations — no new thread-reading needed, see project_comms_status_dashboard_design
// memory's architectural shortcut), derives the 3-state Status, writes it back, and
// Chat-pings on a genuinely NEW 🚨 only (deduped via a GCS marker).
//
// Only ever touches the current/future week's GRN tab(s) — never a past week.
require('dotenv').config();
const sheets = require('../lib/sheets_rest');
const { getAccessToken } = require('../lib/gcp_access_token');
const { parseDayBlocks, countryColumns, resolveCountryCode } = require('../lib/timetable_parser');
const { postChatFlag, postChatError } = require('../lib/chat_notify');
const { readMarker, writeMarker } = require('../lib/gcs_marker_rest');

const TIMETABLE_SPREADSHEET_ID = process.env.TIMETABLE_SPREADSHEET_ID || '1Js1-99MwrN-klxlh23FIzgZSLUhyxQEz62AyBd2HzPw';
const MARKER_BUCKET = process.env.COMMS_TIMETABLE_GCS_BUCKET || `${process.env.GCP_PROJECT || 'prj-grp-couponscrm-prod-46a9'}-comms-timetable-state`;

// Every ROW + UAE country shares NA's own Sends-tab schema (confirmed verbatim-copied
// in row_newsletter_automation/lib/sends_tab_rest.js). UK's Dates tab is a different,
// simpler shape (confirmed in uk_newsletter_automation/lib/dates_tab_rest.js).
const ROW_SENDS_COLS = { date: 1, state: 4, notes: 12, scenarioLink: 15 };
const UK_DATES_COLS = { sendDate: 2, status: 5, notes: 7, scenarioLink: 13 };

// Real current spreadsheet IDs — UK Dates tab + NA Sends tab from project memory, every
// ROW+UAE country from row_newsletter_automation/lib/country_config.js's own
// NEW_SENDS_SHEET_ID map (the authoritative, current source).
const SOURCES = {
  UK: { spreadsheetId: '1Q6Pl3Z3KVJBfX4HPBElZ7ENDybC5kWS9YhwKFMeBLTU', tab: 'Dates', cols: UK_DATES_COLS, kind: 'uk' },
  'NA CO': { spreadsheetId: '1nRf73lrKp-8WuyIjiwwSde_9hvdVzxsQYxPrXAaurNI', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  'NA CW': { spreadsheetId: '1nRf73lrKp-8WuyIjiwwSde_9hvdVzxsQYxPrXAaurNI', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  AU: { spreadsheetId: '1dl1TIfEBvsH6r3UHQkBWECJSXaK8N7crz9nZLqUv0mU', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  DE: { spreadsheetId: '1P8gHeB1O6ICz1hy12-0z0AEZE71JjPAwb8v6cJH1Zb0', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  FR: { spreadsheetId: '1p66TnNUpkAeCW1aN--SVN8FbRecSJ2i8ZwiF-Wvb-S8', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  IE: { spreadsheetId: '1ajxWFWEvJf_iEsDVMCCg8lwAzZR_hnm-nwNNXZjBeTA', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  IT: { spreadsheetId: '1i1vUoMGyDs0CpNNykzAd-cWPo2NMCj4o2Wb-SCWC9uk', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  NL: { spreadsheetId: '1DAdZrnFmbCmyHsZn-O3SOZJZ7E314SJOl7YBgM47eS0', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  PL: { spreadsheetId: '1SD78TigKLJOjl9t3ZKdMApu9M5UZNP4ft0tYlKYQTOA', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  ES: { spreadsheetId: '1HLuLXVU5u0LAhJ8TI1a56FBCKcef2shNLnjRPY0Z3Q4', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
  UAE: { spreadsheetId: '1nOqLoUcaf9BpcybrSk9oooCSCjo0QUrX2ciBO0X4qD0', tab: 'Sends', cols: ROW_SENDS_COLS, kind: 'row' },
};

// Kasia's explicit spec: terse, no narrative, no quoted detail — 2-3 words, period.
const NOTES_FLAG_PATTERNS = [
  { re: /AMBIGUOUS/i, label: 'unclear reply' },
  { re: /DEFECT REPORT/i, label: 'defect reported' },
  { re: /NOT APPLIED/i, label: 'swap not applied' },
];

function isLockedState(source, value) {
  if (source.kind === 'uk') return /ready for bloomreach/i.test(value || '');
  return value === 'Locked';
}

// Parses "DD/MM/YYYY" or "YYYY-MM-DD" into an ISO date string — tolerant of whichever
// format a given source actually uses, rather than assuming one.
function toIsoDate(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Parses the GRN tab's own "Weekday: DD.MM.YY" Send-date cell convention into ISO.
function sendDateCellToIso(cellText) {
  const m = (cellText || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (!m) return null;
  return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const _sheetIdCache = new Map();
async function getSheetId(tabName) {
  if (_sheetIdCache.has(tabName)) return _sheetIdCache.get(tabName);
  const meta = await sheets.getSheetMeta(TIMETABLE_SPREADSHEET_ID);
  const found = meta.find((m) => m.title === tabName);
  if (found) _sheetIdCache.set(tabName, found.sheetId);
  return found ? found.sheetId : null;
}

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

// Finds every "GRN DD.MM.YY" tab whose week hasn't fully passed yet — never touches a
// past week's tab (confirmed scope). A week "hasn't passed" if its Monday is today or
// later minus a few days of slack (keep the current week visible through its own
// Sunday, not just its Monday).
async function findCurrentOrFutureGrnTabs() {
  const meta = await sheets.getSheetMeta(TIMETABLE_SPREADSHEET_ID);
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7); // keep last week's tab visible a bit past Monday, never further back

  return meta
    .filter((m) => /^GRN \d{2}\.\d{2}\.\d{2}$/.test(m.title))
    .filter((m) => {
      const [, dmy] = m.title.match(/^GRN (\d{2}\.\d{2}\.\d{2})$/);
      const [dd, mm, yy] = dmy.split('.');
      const tabMonday = new Date(`20${yy}-${mm}-${dd}T00:00:00Z`);
      return tabMonday >= cutoff;
    })
    .map((m) => m.title);
}

const _sendsCache = new Map(); // `${spreadsheetId}:${tab}` -> rows (fetched once per run)
async function readSendsRows(source) {
  const cacheKey = `${source.spreadsheetId}:${source.tab}`;
  if (_sendsCache.has(cacheKey)) return _sendsCache.get(cacheKey);
  const colCount = Math.max(...Object.values(source.cols));
  const range = `${source.tab}!A2:${sheets.colLetter(colCount)}5000`;
  const raw = await sheets.readRange(source.spreadsheetId, range);
  const rows = raw.filter((r) => r && r[0]).map((r, i) => ({ rowNumber: i + 2, values: r }));
  _sendsCache.set(cacheKey, rows);
  return rows;
}

function findSourceRow(rows, source, targetIso) {
  const dateColIdx = (source.cols.date || source.cols.sendDate) - 1;
  return rows.find((r) => toIsoDate(r.values[dateColIdx]) === targetIso) || null;
}

function deriveStatus(source, row) {
  if (!row) return null; // nothing to report yet — not an error, just not started
  const stateVal = row.values[(source.cols.state || source.cols.status) - 1] || '';
  const notesVal = row.values[source.cols.notes - 1] || '';
  const scenarioLink = row.values[source.cols.scenarioLink - 1] || '';

  if (isLockedState(source, stateVal) && scenarioLink) {
    return { emoji: '🔓', label: 'Scenario in Bloomreach' };
  }
  for (const { re, label } of NOTES_FLAG_PATTERNS) {
    if (re.test(notesVal)) return { emoji: '🚨', label };
  }
  if (stateVal) return { emoji: '📝', label: 'In progress' };
  return null;
}

async function main() {
  const tabNames = await findCurrentOrFutureGrnTabs();
  console.log(`status-poller: checking ${tabNames.length} GRN tab(s): ${tabNames.join(', ')}`);

  for (const tabName of tabNames) {
    const marker = (await readMarker(MARKER_BUCKET, `status_${tabName}.json`).catch(() => null)) || { cells: {} };
    let markerDirty = false;

    let rowData;
    try {
      rowData = await fetchGrid(tabName);
    } catch (err) {
      await postChatError(`GRN tab unreadable — ${tabName}`);
      console.error(err);
      continue;
    }
    const blocks = parseDayBlocks(rowData);

    for (const block of blocks) {
      const statusField = block.fields.Status;
      const sendDateField = block.fields['Send date'];
      if (!statusField || !sendDateField) {
        await postChatError(`GRN column missing — ${tabName} ${block.dayName}`);
        continue;
      }
      const cols = countryColumns(block);
      for (const { code: rawCode, colIndex } of cols) {
        const code = resolveCountryCode(rawCode, block.dayName);
        const source = SOURCES[code];
        if (!source) {
          console.warn(`  (!) no known source mapping for "${code}" (${tabName} ${block.dayName} col ${colIndex + 1})`);
          continue;
        }

        const sendDateCell = sendDateField.cells[colIndex]?.text;
        const targetIso = sendDateCellToIso(sendDateCell);
        if (!targetIso) continue; // Send date not filled in yet — nothing to check

        let rows;
        try {
          rows = await readSendsRows(source);
        } catch (err) {
          await postChatError(`Sends sheet unreadable — ${code}`);
          console.error(err);
          continue;
        }
        const row = findSourceRow(rows, source, targetIso);
        const status = deriveStatus(source, row);

        const markerKey = `${block.dayName}:${colIndex}`;
        const prevEmoji = marker.cells[markerKey]?.emoji;

        if (status) {
          const cellText = `${status.emoji} ${status.label}`;
          const range = `${sheets.quoteSheetTitle(tabName)}!${sheets.colLetter(colIndex + 1)}${statusField.rowNumber}`;
          const existing = statusField.cells[colIndex]?.text;
          if (existing !== cellText) {
            await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, range, [[cellText]]);
            await sheets.setCellFormat(TIMETABLE_SPREADSHEET_ID, await getSheetId(tabName), statusField.rowNumber - 1, colIndex, {
              horizontalAlignment: 'LEFT',
              wrapStrategy: 'CLIP',
            });
            console.log(`  ${tabName} ${code} (${block.dayName}) Status -> ${cellText}`);
          }
          if (status.emoji === '🚨' && prevEmoji !== '🚨') {
            await postChatFlag(code, targetIso, status.label);
          }
          marker.cells[markerKey] = { emoji: status.emoji };
          markerDirty = true;
        }
      }
    }

    if (markerDirty) await writeMarker(MARKER_BUCKET, `status_${tabName}.json`, marker);
  }

  console.log('status-poller: done.');
}

module.exports = { main, deriveStatus, findSourceRow, toIsoDate, sendDateCellToIso, findCurrentOrFutureGrnTabs };

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await postChatError(`status-poller crashed — ${err.message}`).catch(() => {});
    process.exit(1);
  });
}
