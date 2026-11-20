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
const { GRN_BUILD_SCHEDULE, applyBfCmOverride } = require('../lib/bf_cm_overrides');
const { postChatFlag, postChatError } = require('../lib/chat_notify');
const { readMarker, writeMarker } = require('../lib/gcs_marker_rest');

const TIMETABLE_SPREADSHEET_ID = process.env.TIMETABLE_SPREADSHEET_ID || '1Js1-99MwrN-klxlh23FIzgZSLUhyxQEz62AyBd2HzPw';
const MARKER_BUCKET = process.env.COMMS_TIMETABLE_GCS_BUCKET || `${process.env.GCP_PROJECT || 'prj-grp-couponscrm-prod-46a9'}-comms-timetable-state`;

// REWRITTEN 18 Nov 2026 — these used to be hardcoded column NUMBERS (`date: 1, state: 4,
// notes: 12, scenarioLink: 15`), copied by hand from each repo's schema at build time.
// That's exactly the fragility class Kasia flagged the same day: this file has zero
// ownership of na_/uk_/row_newsletter_automation's own tracking-sheet schemas, so a
// hardcoded position silently drifts the moment any of those three repos adds or
// reorders a column — which happened literally the same day (Subject Chars/Preheader
// Chars columns added to all three). It happened to land after every position this file
// already depended on, so nothing broke this time — but that was luck, not design.
// Columns are now resolved by HEADER TEXT, read fresh from each sheet's own row 1 every
// run (cached per spreadsheet+tab for the run's duration) — the same "never write/read by
// a remembered position" discipline this file already applies to the Timetable sheet
// itself (see project_comms_status_dashboard_design memory's "Matching discipline"
// section), now applied to the sheets it reads FROM too, not just the one it writes to.
const ROW_SENDS_LABELS = { date: 'Date', state: 'State', notes: 'Notes', scenarioLink: 'Scenario Link' };
const UK_DATES_LABELS = { sendDate: 'Send Date', status: 'Status', notes: 'Notes', scenarioLink: 'Scenario Link' };

// Real current spreadsheet IDs — UK Dates tab + NA Sends tab from project memory, every
// ROW+UAE country from row_newsletter_automation/lib/country_config.js's own
// NEW_SENDS_SHEET_ID map (the authoritative, current source).
const SOURCES = {
  UK: { spreadsheetId: '1Q6Pl3Z3KVJBfX4HPBElZ7ENDybC5kWS9YhwKFMeBLTU', tab: 'Dates', labels: UK_DATES_LABELS, kind: 'uk' },
  'NA CO': { spreadsheetId: '1nRf73lrKp-8WuyIjiwwSde_9hvdVzxsQYxPrXAaurNI', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  'NA CW': { spreadsheetId: '1nRf73lrKp-8WuyIjiwwSde_9hvdVzxsQYxPrXAaurNI', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  AU: { spreadsheetId: '1dl1TIfEBvsH6r3UHQkBWECJSXaK8N7crz9nZLqUv0mU', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  DE: { spreadsheetId: '1P8gHeB1O6ICz1hy12-0z0AEZE71JjPAwb8v6cJH1Zb0', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  FR: { spreadsheetId: '1p66TnNUpkAeCW1aN--SVN8FbRecSJ2i8ZwiF-Wvb-S8', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  IE: { spreadsheetId: '1ajxWFWEvJf_iEsDVMCCg8lwAzZR_hnm-nwNNXZjBeTA', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  IT: { spreadsheetId: '1i1vUoMGyDs0CpNNykzAd-cWPo2NMCj4o2Wb-SCWC9uk', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  NL: { spreadsheetId: '1DAdZrnFmbCmyHsZn-O3SOZJZ7E314SJOl7YBgM47eS0', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  PL: { spreadsheetId: '1SD78TigKLJOjl9t3ZKdMApu9M5UZNP4ft0tYlKYQTOA', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  ES: { spreadsheetId: '1HLuLXVU5u0LAhJ8TI1a56FBCKcef2shNLnjRPY0Z3Q4', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
  UAE: { spreadsheetId: '1nOqLoUcaf9BpcybrSk9oooCSCjo0QUrX2ciBO0X4qD0', tab: 'Sends', labels: ROW_SENDS_LABELS, kind: 'row' },
};

// Reads row 1 of a source sheet once, resolves every label in source.labels to its real
// current column number. Throws (loudly — same "flag, never silently skip" rule this
// file already follows for everything else) if a label can't be found, since a missing
// header means this file's whole model of that sheet is now wrong, not just one field.
const _colsCache = new Map(); // `${spreadsheetId}:${tab}` -> resolved cols object
async function resolveCols(source) {
  const cacheKey = `${source.spreadsheetId}:${source.tab}`;
  if (_colsCache.has(cacheKey)) return _colsCache.get(cacheKey);
  const headerRow = (await sheets.readRange(source.spreadsheetId, `${source.tab}!A1:Z1`))[0] || [];
  const cols = {};
  for (const [key, label] of Object.entries(source.labels)) {
    const idx = headerRow.findIndex((h) => (h || '').trim() === label);
    if (idx === -1) {
      throw new Error(`column "${label}" not found in ${source.tab} tab header row (looked for key "${key}")`);
    }
    cols[key] = idx + 1; // 1-indexed, matching every other column-number convention in this file
  }
  _colsCache.set(cacheKey, cols);
  return cols;
}

// Kasia's explicit spec: terse, no narrative, no quoted detail — 2-3 words, period.
//
// FIXED 20 Nov 2026 (real incident, NA 27/11): anchored to the start of the entry. Every
// genuine tag is written as "TAG [<timestamp>] ..." (see reply_loop_orchestrator.js's
// notesLines.push() calls for AMBIGUOUS/DEFECT REPORT/NOT APPLIED) — the old unanchored
// /AMBIGUOUS/i matched the bare word anywhere in free text, so a note like "CC search
// was ambiguous (many generic QVC BF offers...)" — a build-time offer-resolution comment
// with no reply involved at all — wrongly showed as "unclear reply" on the dashboard.
const NOTES_FLAG_PATTERNS = [
  { re: /^\s*AMBIGUOUS\s*\[/i, label: 'unclear reply' },
  { re: /^\s*DEFECT REPORT\b/i, label: 'defect reported' },
  { re: /^\s*NOT APPLIED\s*\[/i, label: 'request not applied' },
];

// Notes columns on every source sheet are append-only history ('||'/'|'-joined entries,
// newest last) — they never clear. REWRITTEN 19 Nov 2026 (second stale-🚨 incident, NA
// 22.11: a resolved bottom-banner request kept the cell flagged for hours, someone
// hand-annotated "swap applied" under it): a flag pattern only counts if it appears in
// the LATEST entry. Anything appended after a flag means the automation or a human
// acted again — the old flag is history, not the current state.
function latestNotesEntry(notesVal) {
  const parts = String(notesVal || '').split(/\s*\|\|\s*|\s+\|\s+/).filter((s) => s.trim());
  return parts.length ? parts[parts.length - 1] : '';
}

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
  const res = await sheets.fetchWithRetry(async () => {
    const token = await getAccessToken();
    return fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${TIMETABLE_SPREADSHEET_ID}?ranges=${encodeURIComponent(`'${tabName}'!A1:AB400`)}&fields=sheets.data.rowData.values(formattedValue,hyperlink)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }, `fetchGrid ${tabName}`);
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
  // WIDENED 19 Nov 2026 (was -7): a tab must stay in scope until ALL of its SENDS have
  // happened, not until its build week feels old. GRN_BUILD_SCHEDULE's largest offset is
  // the Friday block's NA CO at +7 days — a send staged by a tab can land as late as that
  // tab's Monday + 11 (Fri = Mon+4, +7). The old 7-day window dropped a tab while several
  // of its sends were still in the future, so any status change after that (a Bloomreach
  // scenario built, a late approval) silently never reached the dashboard. Real incidents:
  // NA CO 19/11 on GRN 09.11.26 (17 Nov, corrected by hand) and NA CO 20/11 on the same
  // tab (19 Nov — scenario built, cell stuck on a stale status). 12 = 11 + one day of
  // post-send settling. The 17 Nov "confirmed intentional scope" note in
  // project_comms_status_dashboard_design described the -7 behavior, not a requirement —
  // superseded by this.
  cutoff.setUTCDate(cutoff.getUTCDate() - 12);

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
async function readSendsRows(source, cols) {
  const cacheKey = `${source.spreadsheetId}:${source.tab}`;
  if (_sendsCache.has(cacheKey)) return _sendsCache.get(cacheKey);
  const colCount = Math.max(...Object.values(cols));
  const range = `${source.tab}!A2:${sheets.colLetter(colCount)}5000`;
  const raw = await sheets.readRange(source.spreadsheetId, range);
  const rows = raw.filter((r) => r && r[0]).map((r, i) => ({ rowNumber: i + 2, values: r }));
  _sendsCache.set(cacheKey, rows);
  return rows;
}

function findSourceRow(rows, cols, targetIso) {
  const dateColIdx = (cols.date || cols.sendDate) - 1;
  return rows.find((r) => toIsoDate(r.values[dateColIdx]) === targetIso) || null;
}

// Hannah's ask via Kasia, 13 Nov 2026: surface the real Bloomreach scenario link
// directly in the timetable, in the row that used to be "Submission deadline" (dead
// weight from the old workflow — nothing read or wrote it). Same scenarioLink value
// deriveStatus() already reads for the 🔓 check, just exposed separately so main() can
// write it regardless of which Status emoji that row ends up with.
function getScenarioLink(cols, row) {
  if (!row) return '';
  return row.values[cols.scenarioLink - 1] || '';
}

// "Draft"/"Pending" means queued/not started yet — the build genuinely hasn't happened,
// so it must show no status at all, same as no row existing yet. Originally written
// 16 Nov 2026 against "Pending" (Kasia: UK's 20/11 send showed "📝 In progress" a full
// day before its Tuesday build even started) — but NA/UK/ROW's real initial/reset state
// value is literally "Draft" everywhere (confirmed directly against all three repos'
// tracking-sheet readers — none of them ever write "Pending"), so this check never
// actually matched anything and the 16 Nov fix silently never worked. FIXED 20 Nov 2026
// (real incident: DE and FR, both correctly reverted to Draft on 19 Nov, both still
// showed "📝 In progress" on the dashboard — Kasia caught it, not a poller run).
function isNotStartedState(stateVal) {
  return /^(draft|pending)$/i.test(stateVal.trim());
}

// REWRITTEN 19 Nov 2026 (Kasia: "still not working in sync with approvals and bloomreach
// scenario... this needs a stable and permanent fix"). The old 3-state taxonomy had two
// structural blind spots, both confirmed live that day:
//   - a Locked/approved send with no scenario yet (or a FAILED scenario build — NA 11/20
//     sat that way 15h, NA 11/21 indefinitely) rendered as plain "📝 In progress",
//     indistinguishable from "nobody has approved anything";
//   - a source row in "Build Failed — see Notes" (NA 11/26) ALSO rendered as
//     "📝 In progress", hiding a real failure.
// Approval is now a first-class state, and failure states surface as 🚨.
function deriveStatus(source, cols, row) {
  if (!row) return null; // nothing to report yet — not an error, just not started
  const stateVal = row.values[(cols.state || cols.status) - 1] || '';
  const notesVal = row.values[cols.notes - 1] || '';
  const scenarioLink = row.values[cols.scenarioLink - 1] || '';
  const locked = isLockedState(source, stateVal);

  if (locked && scenarioLink) {
    return { emoji: '🔓', label: 'Scenario in Bloomreach' };
  }
  if (locked) {
    // Approved but the scenario isn't there. If the hook itself reported a failure,
    // that's an actionable alert; otherwise the build fires seconds after lock, so
    // "pending" should only ever show for one poll cycle — persisting longer is itself
    // the visible signal something is wrong, instead of the old silent "In progress".
    if (/Bloomreach build failed/i.test(latestNotesEntry(notesVal))) {
      return { emoji: '🚨', label: 'scenario build failed' };
    }
    return { emoji: '✅', label: 'Approved — scenario pending' };
  }
  // A real failure state on the source row (e.g. NA's "Build Failed — see Notes") must
  // never display as routine progress.
  if (/failed/i.test(stateVal)) {
    return { emoji: '🚨', label: 'build failed' };
  }
  // 17 Nov 2026 rule (kept): only flag while genuinely in flight. 19 Nov narrowing: only
  // the LATEST notes entry counts — see latestNotesEntry().
  const lastEntry = latestNotesEntry(notesVal);
  for (const { re, label } of NOTES_FLAG_PATTERNS) {
    if (re.test(lastEntry)) return { emoji: '🚨', label };
  }
  if (stateVal && !isNotStartedState(stateVal)) return { emoji: '📝', label: 'In progress' };
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

    // Derive each block's own build date from the tab name's Monday (GRN DD.MM.YY) +
    // the block's weekday — `parseDayBlocks` doesn't carry it, and weekly-setup.js
    // annotates it only on its own in-memory copy. Without this the send-date mismatch
    // guard below could never evaluate (found 19 Nov 2026 by diffing every board cell
    // against its expectation and getting "no schedule entry" for all of them — the
    // guard shipped inert earlier the same day).
    const tabMonday = (() => {
      const m = tabName.match(/^GRN (\d{2})\.(\d{2})\.(\d{2})$/);
      return m ? new Date(`20${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : null;
    })();
    const DAY_OFFSET = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4 };
    for (const b of blocks) {
      if (tabMonday && DAY_OFFSET[b.dayName] !== undefined) {
        const d = new Date(tabMonday);
        d.setUTCDate(d.getUTCDate() + DAY_OFFSET[b.dayName]);
        b.buildDateIso = d.toISOString().slice(0, 10);
      }
    }

    for (const block of blocks) {
      const statusField = block.fields.Status;
      const sendDateField = block.fields['Send date'];
      if (!statusField || !sendDateField) {
        await postChatError(`GRN column missing — ${tabName} ${block.dayName}`);
        continue;
      }
      const cols = countryColumns(block);
      for (let ci = 0; ci < cols.length; ci++) {
        const { code: rawCode, colIndex } = cols[ci];
        const code = resolveCountryCode(rawCode, block.dayName);
        const source = SOURCES[code];
        if (!source) {
          console.warn(`  (!) no known source mapping for "${code}" (${tabName} ${block.dayName} col ${colIndex + 1})`);
          continue;
        }

        const sendDateCell = sendDateField.cells[colIndex]?.text;
        const targetIso = sendDateCellToIso(sendDateCell);
        if (!targetIso) continue; // Send date not filled in yet — nothing to check

        // Send-date mismatch guard (added 19 Nov 2026). Real incident same day: a human
        // hand-edited the Thursday block's DE Send date from the BF-override Fri 27.11
        // back to DE's normal Mon 23.11 — no source row matches that date, so the poller
        // went silent and a stale 🔓 sat under a wrong date for hours. Recompute what
        // weekly-setup itself would have written (fixed day-offset + the BF/CM override
        // table) and surface any divergence as a visible 🚨 + one Chat ping, instead of
        // silently showing stale state. The cell is NOT auto-corrected — a mismatch can
        // also mean a real schedule change the override table doesn't know yet; either
        // way a human needs to see it, never a quiet wrong dashboard.
        const schedEntry = (GRN_BUILD_SCHEDULE[block.dayName] || [])[ci];
        let dateMismatch = null;
        if (schedEntry && schedEntry.country === code && block.buildDateIso) {
          const d = new Date(`${block.buildDateIso}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + schedEntry.offsetDays);
          const expected = applyBfCmOverride(code, d.toISOString().slice(0, 10));
          if (expected.dateIso !== targetIso) {
            dateMismatch = { expectedIso: expected.dateIso, foundIso: targetIso };
          }
        }

        let rows, sourceCols;
        try {
          sourceCols = await resolveCols(source);
          rows = await readSendsRows(source, sourceCols);
        } catch (err) {
          await postChatError(`Sends sheet unreadable — ${code}`);
          console.error(err);
          continue;
        }
        const row = findSourceRow(rows, sourceCols, targetIso);
        let status = deriveStatus(source, sourceCols, row);
        // A mismatched date whose own lookup found nothing is pure staleness — the 🚨
        // replaces whatever old status is sitting there. If a row DOES match the cell's
        // date (a legitimate reschedule the override table doesn't know), the row's own
        // real status wins and the mismatch only goes to Chat via the 🚨 transition below.
        if (dateMismatch && !row) {
          status = { emoji: '🚨', label: 'send date mismatch' };
        }

        const markerKey = `${block.dayName}:${colIndex}`;
        const prevEmoji = marker.cells[markerKey]?.emoji;

        const range = `${sheets.quoteSheetTitle(tabName)}!${sheets.colLetter(colIndex + 1)}${statusField.rowNumber}`;
        const existing = statusField.cells[colIndex]?.text;
        if (status) {
          const cellText = `${status.emoji} ${status.label}`;
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
        } else if (existing) {
          // FIXED 20 Nov 2026 (real incident: DE/FR reverted to Draft, deriveStatus()
          // correctly started returning null again, but nothing ever cleared the stale
          // "In progress" text an earlier poll had written — this branch never existed).
          // writeRange with an empty string silently no-ops on this sheet (same gotcha as
          // the GRN free-text note cells) — use the dedicated clear endpoint instead.
          await sheets.clearRange(TIMETABLE_SPREADSHEET_ID, range);
          console.log(`  ${tabName} ${code} (${block.dayName}) Status -> (cleared, not started)`);
          delete marker.cells[markerKey];
          markerDirty = true;
        }

        // Hannah's ask via Kasia, 13 Nov 2026: surface the real Bloomreach scenario
        // link in the "BR Link" row (replaces the old, unused "Submission deadline").
        // Only writes when a real link exists — never clears a previously-captured
        // link on a later poll that happens to read a blank value.
        const brLinkField = block.fields['BR Link'];
        const scenarioLink = getScenarioLink(sourceCols, row);
        if (brLinkField && scenarioLink) {
          const brRange = `${sheets.quoteSheetTitle(tabName)}!${sheets.colLetter(colIndex + 1)}${brLinkField.rowNumber}`;
          const existingBr = brLinkField.cells[colIndex]?.hyperlink;
          if (existingBr !== scenarioLink) {
            await sheets.writeRange(TIMETABLE_SPREADSHEET_ID, brRange, [[`=HYPERLINK("${scenarioLink}","Open")`]], { valueInputOption: 'USER_ENTERED' });
            console.log(`  ${tabName} ${code} (${block.dayName}) BR Link -> ${scenarioLink}`);
          }
        }
      }
    }

    if (markerDirty) await writeMarker(MARKER_BUCKET, `status_${tabName}.json`, marker);
  }

  console.log('status-poller: done.');
}

module.exports = { main, deriveStatus, isNotStartedState, getScenarioLink, findSourceRow, resolveCols, toIsoDate, sendDateCellToIso, findCurrentOrFutureGrnTabs, latestNotesEntry };

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await postChatError(`status-poller crashed — ${err.message}`).catch(() => {});
    process.exit(1);
  });
}
