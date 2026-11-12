// lib/timetable_parser.js — shared content-based parser for the Timetable sheet's
// "transposed" day-block layout (fields as row labels, country/newsletter instances as
// parallel columns within a block). Used by both jobs/weekly-setup.js and
// jobs/status-poller.js so the matching discipline lives in exactly one place — never
// by a remembered row/column number (see project_comms_status_dashboard_design memory's
// "Matching discipline" rule: a block labeled "Monday" has held Sat/Sun/Mon dates in
// real data; row/column position shifts whenever a human edits the sheet).
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function norm(s) {
  return (s || '').trim();
}

function isDayName(text) {
  return DAY_NAMES.includes(norm(text));
}

// rowData: the Sheets API's own rowData array (1 entry per row, from fetchGrid-style
// calls using fields=sheets.data.rowData.values(formattedValue,hyperlink)).
// Returns an array of blocks:
//   { dayName, dateRaw, dayRowNumber, fields: { label: { rowNumber, cells } } }
// `cells` is the row's raw cell array (index 0 = the label itself, index 1.. = the
// per-column values for that field). A block ends at the next day-name row or a fully
// blank row, whichever comes first — never a fixed row count, since VC's blocks differ
// in shape from GRN's.
function parseDayBlocks(rowData) {
  const rows = rowData.map((r, i) => ({
    rowNumber: i + 1,
    cells: (r.values || []).map((v) => ({ text: norm(v.formattedValue), hyperlink: v.hyperlink || null })),
  }));

  const blocks = [];
  let current = null;

  for (const row of rows) {
    const label = row.cells[0]?.text || '';
    const rowHasContent = row.cells.some((c) => c.text);

    if (isDayName(label) && row.cells[1]?.text) {
      if (current) blocks.push(current);
      current = { dayName: label, dateRaw: row.cells[1].text, dayRowNumber: row.rowNumber, fields: {} };
      continue;
    }

    if (!rowHasContent) {
      if (current) blocks.push(current);
      current = null;
      continue;
    }

    if (current && label) {
      current.fields[label] = { rowNumber: row.rowNumber, cells: row.cells };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

// Country-row cells, skipping the label cell itself. Returns [{ code, colIndex }] —
// colIndex is 0-based within the row's cells array (matches parseDayBlocks' `cells`).
function countryColumns(block) {
  const countryField = block.fields.Country;
  if (!countryField) return [];
  return countryField.cells
    .map((c, colIndex) => ({ code: c.text, colIndex }))
    .filter((c) => c.colIndex > 0 && c.code);
}

// Naming drift, confirmed live: GRN Template still has several blocks using bare "NA"
// (pre-dating the NA CO/CW split) while the live tab already uses "NA CO"/"NA CW".
// Resolve contextually by the block's own weekday — NA CW is Wednesday ONLY, every
// other day is NA CO — rather than guessing a single blind alias. Shared by
// jobs/weekly-setup.js (Send-date prefill) and jobs/status-poller.js (Sends-sheet
// lookup) so both agree on the same resolution.
function resolveCountryCode(rawCode, dayName) {
  if (rawCode !== 'NA') return rawCode;
  return dayName === 'Wednesday' ? 'NA CW' : 'NA CO';
}

module.exports = { DAY_NAMES, isDayName, parseDayBlocks, countryColumns, norm, resolveCountryCode };
