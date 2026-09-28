var WORKER_URL = 'https://qid-quotes.parasha.workers.dev';
// Must match the worker's RERUN_SECRET (wrangler secret put RERUN_SECRET).
// Paste the real value in the Apps Script editor only — never commit it.
var RERUN_SECRET = 'PASTE_RERUN_SECRET_HERE';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QidQuotes')
    .addItem('Rerun selected row(s)', 'rerunSelectedRows')
    .addToUi();
}

// Calls the worker's /regen endpoint — the same path as the Telegram 🔄 Regenerate
// button (reference photos, Telegram post, sheet write-back). The worker picks the
// column, so this script only sends row numbers.
function rerunSelectedRows() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet.getActiveRange();
  var startRow = range.getRow();
  var numRows = range.getNumRows();

  // Skip header row if selected
  if (startRow === 1) { startRow = 2; numRows = numRows - 1; }
  if (numRows <= 0) { ui.alert('Select at least one data row.'); return; }

  // Collect rows that have a child and a quote
  var values = sheet.getRange(startRow, 1, numRows, 4).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][2] && values[i][3]) rows.push(startRow + i);
  }
  if (rows.length === 0) { ui.alert('No data rows found in selection.'); return; }

  // One request per row keeps each worker run small.
  var errors = [];
  for (var j = 0; j < rows.length; j++) {
    SpreadsheetApp.getActive().toast('Row ' + rows[j], 'Submitting ' + (j + 1) + ' of ' + rows.length, 10);
    try {
      var resp = UrlFetchApp.fetch(WORKER_URL + '/regen', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ secret: RERUN_SECRET, rows: [rows[j]], model: 'gpt' }),
        muteHttpExceptions: true
      });
      var result = JSON.parse(resp.getContentText());
      if (!result.ok) errors.push('Row ' + rows[j] + ': ' + result.error);
    } catch (e) {
      errors.push('Row ' + rows[j] + ': ' + e.message);
    }
  }

  var msg = (rows.length - errors.length) + ' of ' + rows.length +
    ' submitted. Cards will arrive in Telegram and the sheet in ~30s each.';
  if (errors.length > 0) msg += '\n\nFailed:\n' + errors.join('\n');
  ui.alert(msg);
}
