var WORKER_URL = 'https://qid-quotes.parasha.workers.dev';
var RERUN_SECRET = 'Gutezachen123!';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QidQuotes')
    .addItem('Rerun selected row(s)', 'rerunSelectedRows')
    .addToUi();
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Returns the first column letter (starting from F) that is empty in ALL rows of the selection.
function nextBatchCol(sheet, firstRow, lastRow) {
  var numRows = lastRow - firstRow + 1;
  var block = sheet.getRange(firstRow, 6, numRows, 20).getValues(); // F through Y
  for (var col = 0; col < 20; col++) {
    var allEmpty = true;
    for (var row = 0; row < block.length; row++) {
      if (block[row][col]) { allEmpty = false; break; }
    }
    if (allEmpty) { return String.fromCharCode(70 + col); } // 70='F'
  }
  return String.fromCharCode(70 + 20);
}

function rerunSelectedRows() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet.getActiveRange();
  var startRow = range.getRow();
  var numRows = range.getNumRows();

  if (startRow === 1) { startRow = 2; numRows = numRows - 1; }
  if (numRows <= 0) { ui.alert('Select at least one data row.'); return; }

  var lastRow = startRow + numRows - 1;

  // Collect rows with data
  var rows = [];
  for (var i = 0; i < numRows; i++) {
    var row = startRow + i;
    var rowData = sheet.getRange(row, 1, 1, 4).getValues()[0];
    var childName = rowData[2];
    var quoteText = rowData[3];
    if (childName && quoteText) {
      rows.push({ row: row, date: rowData[0], childName: childName, quoteText: quoteText });
    }
  }

  if (rows.length === 0) { ui.alert('No data rows found in selection.'); return; }

  // One column for the whole batch
  var col = nextBatchCol(sheet, startRow, lastRow);

  var errors = [];
  var successes = 0;

  for (var j = 0; j < rows.length; j++) {
    var item = rows[j];
    var progress = (j + 1) + ' of ' + rows.length;

    SpreadsheetApp.getActive().toast(
      item.childName + ': "' + item.quoteText.substring(0, 40) + '"',
      'Generating ' + progress + ' -> col ' + col,
      120
    );

    var dateStr = '';
    if (item.date instanceof Date) {
      dateStr = pad2(item.date.getMonth() + 1) + '/' + pad2(item.date.getDate()) + '/' + item.date.getFullYear();
    }

    try {
      var payload = JSON.stringify({
        secret: RERUN_SECRET,
        childName: item.childName,
        quoteText: item.quoteText,
        date: dateStr,
        row: item.row,
        col: col
      });

      var resp = UrlFetchApp.fetch(WORKER_URL + '/rerun', {
        method: 'post',
        contentType: 'application/json',
        payload: payload,
        muteHttpExceptions: true,
        deadline: 120
      });

      var result = JSON.parse(resp.getContentText());
      if (result.ok) {
        successes++;
        SpreadsheetApp.getActive().toast(
          'Saved to col ' + col,
          'Done ' + progress,
          4
        );
      } else {
        errors.push('Row ' + item.row + ' (' + item.childName + '): ' + result.error);
      }
    } catch (e) {
      errors.push('Row ' + item.row + ' (' + item.childName + '): ' + e.message);
    }
  }

  var msg = successes + ' of ' + rows.length + ' images regenerated into column ' + col + '.';
  if (errors.length > 0) { msg += '\n\nFailed:\n' + errors.join('\n'); }
  ui.alert(msg);
}
