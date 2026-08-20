/**
 * Workbook-aware helpers for the two things DuckDB's excel extension does not do.
 *
 * DuckDB reads a workbook perfectly well — `read_xlsx(path, sheet = 'Items')` —
 * so nothing here is on the read path. What it cannot do is:
 *
 *   LIST the sheets. There is no `xlsx_sheets()` function, and a connection has
 *     to know what a workbook holds before it can register a table per sheet.
 *
 *   WRITE one sheet. `COPY … TO 'book.xlsx' (FORMAT xlsx)` builds a NEW
 *     workbook containing only what it was given — verified: writing `Orders`
 *     back to a two-sheet book leaves a file with `Orders` and nothing else.
 *     For a single-sheet workbook that is exactly right and DuckDB does it. For
 *     a multi-sheet one it is silent data loss, so the write goes through
 *     `replaceSheet` below, which rewrites the workbook around the one sheet
 *     that changed.
 *
 * Both use the `xlsx` package, required lazily so a session that never opens a
 * spreadsheet never pays to load it.
 */

const fs = require('fs');
const path = require('path');

/** Extensions the excel extension can read — an OOXML zip, in both cases. */
const WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm']);

/**
 * Legacy spreadsheet formats DuckDB cannot open, kept separate from "unknown"
 * so the app can say WHY rather than "unsupported file".
 *
 *   .xls  is BIFF, not a zip at all — `IO Error: Failed to open zip for reading`
 *   .xlsb is a zip of binary parts — `No xl/workbook.xml found in xlsx file`
 */
const LEGACY_EXTENSIONS = new Set(['.xls', '.xlsb']);

const extensionOf = (filePath) => path.extname(String(filePath || '')).toLowerCase();

const isWorkbook = (filePath) => WORKBOOK_EXTENSIONS.has(extensionOf(filePath));
const isLegacyWorkbook = (filePath) => LEGACY_EXTENSIONS.has(extensionOf(filePath));

/** What to tell a user who picked a format DuckDB will not open. */
const legacyMessage = (filePath) => (
  extensionOf(filePath) === '.xls'
    ? `Excel 97–2003 (.xls) files are not supported. Open "${path.basename(filePath)}" in Excel and save it as .xlsx.`
    : `Binary Excel (.xlsb) files are not supported. Open "${path.basename(filePath)}" in Excel and save it as .xlsx.`
);

/**
 * The sheet names in a workbook, in workbook order.
 *
 * `bookSheets` parses the workbook's index and none of its cells, so this stays
 * cheap on a large file. Empty sheets are still listed — whether a sheet has
 * anything readable in it is DuckDB's call, made when the caller probes it.
 */
function listSheets(filePath) {
  // eslint-disable-next-line global-require
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath, { bookSheets: true });
  return workbook.SheetNames || [];
}

/**
 * A cell value a spreadsheet can hold.
 *
 * Rows arrive from DuckDB already reduced to JSON-safe values, which still
 * leaves STRUCT and LIST columns as objects and arrays. A cell cannot hold one,
 * so they are written as their JSON text — the same thing the grid shows.
 */
function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Replace ONE sheet's contents, leaving the rest of the workbook alone.
 *
 * The existing file is read, the named sheet is swapped for the rows given, and
 * the whole book is written to a sibling temp file and renamed into place — so
 * a failure part-way leaves the original untouched, exactly as copyToFile does.
 *
 * What survives is every other sheet's data and this sheet's new values. What
 * does not is anything the xlsx package cannot round-trip — charts, pivot
 * tables, conditional formatting, and the macros in a .xlsm. A workbook that
 * carries those is better exported with `COPY … TO` than edited in place.
 *
 * @param {string} filePath   the workbook to rewrite
 * @param {string} sheetName  the sheet to replace
 * @param {object[]} rows     the sheet's new contents
 * @param {string[]} columns  column order, since rows are unordered objects
 */
function replaceSheet(filePath, sheetName, rows, columns) {
  return writeSheet(filePath, sheetName, rows, columns);
}

/**
 * A sheet name Excel will accept.
 *
 * Excel rejects a name over 31 characters or containing any of `\ / ? * [ ] :`,
 * and refuses one wrapped in apostrophes. A table name is not bound by any of
 * that — `analytics/q3_summary` is a perfectly ordinary one — so a name derived
 * from a table has to be brought inside those rules before it can be written,
 * or the workbook is rejected at save time with nothing to explain why.
 *
 * @param {string} name       the name to make legal
 * @param {string} [fallback] used when nothing legal survives
 */
function sanitizeSheetName(name, fallback = 'Data') {
  const cleaned = String(name || '')
    .replace(/[\\/?*[\]:]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
    .trim();
  return cleaned || fallback;
}

/**
 * Write ONE sheet, creating the workbook if it isn't there yet.
 *
 * The two cases an output node meets. A workbook that already exists is read
 * and rewritten around the named sheet, so every OTHER sheet in it survives —
 * which is what lets several output nodes write several sheets of one file, one
 * node per sheet. A path with no file at it gets a new workbook holding just
 * this sheet.
 *
 * Either way the book goes to a sibling temp file and is renamed into place, so
 * a failure part-way leaves whatever was there untouched.
 *
 * @param {string} filePath   the workbook to write
 * @param {string} sheetName  the sheet to create or replace
 * @param {object[]} rows     the sheet's contents
 * @param {string[]} columns  column order, since rows are unordered objects
 */
function writeSheet(filePath, sheetName, rows, columns) {
  // eslint-disable-next-line global-require
  const XLSX = require('xlsx');

  // An existing workbook is preserved around this sheet; anything else — no
  // file, or a path whose extension isn't one we can read back — starts fresh.
  const existing = isWorkbook(filePath) && fs.existsSync(filePath);
  const workbook = existing ? XLSX.readFile(filePath, { cellDates: true }) : XLSX.utils.book_new();
  const sheet = sanitizeSheetName(sheetName);
  const header = columns && columns.length ? columns : Object.keys(rows[0] || {});
  const cleaned = (rows || []).map((row) => {
    const out = {};
    for (const name of header) out[name] = cellValue(row ? row[name] : null);
    return out;
  });

  workbook.Sheets[sheet] = XLSX.utils.json_to_sheet(cleaned, { header });
  if (!workbook.SheetNames.includes(sheet)) workbook.SheetNames.push(sheet);

  const bookType = extensionOf(filePath) === '.xlsm' ? 'xlsm' : 'xlsx';
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    XLSX.writeFile(workbook, tempPath, { bookType });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return filePath;
}

module.exports = {
  LEGACY_EXTENSIONS,
  WORKBOOK_EXTENSIONS,
  isLegacyWorkbook,
  isWorkbook,
  legacyMessage,
  listSheets,
  replaceSheet,
  writeSheet,
  sanitizeSheetName,
};
