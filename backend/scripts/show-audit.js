#!/usr/bin/env node
'use strict';

/**
 * Human-readable view of the audit trail, plus a chain check.
 *
 * `audit.jsonl` is one dense JSON object per line — correct for machines,
 * unreadable for a person. This prints the same records as a table and then
 * verifies the hash chain, so "is this record intact?" is answerable from a
 * terminal without opening the file.
 *
 *   npm run audit
 */

require('dotenv').config();
const auditLog = require('../src/agent/auditLog');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const OUTCOME_COLOR = { success: C.green, rejected: C.yellow, error: C.red };

function pad(text, width) {
  const s = String(text == null ? '' : text);
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

const entries = auditLog.readAll();

console.log('');
console.log(C.bold + '  AUDIT TRAIL' + C.reset + C.dim + '  ' + auditLog.LOG_PATH + C.reset);
console.log('');

if (!entries.length) {
  console.log(C.dim + '  (empty — run the app and do something first)' + C.reset);
  console.log('');
  process.exit(0);
}

console.log(
  C.dim + '  ' + pad('#', 4) + pad('TIME', 10) + pad('TOOL', 20) +
  pad('OUTCOME', 10) + pad('DETAIL', 34) + 'HASH' + C.reset
);
console.log(C.dim + '  ' + '─'.repeat(96) + C.reset);

for (const e of entries) {
  const color = OUTCOME_COLOR[e.outcome] || C.reset;
  const time = e.ts ? new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false }) : '';
  const detail = e.code || (e.input && (e.input.query || e.input.productId)) || '';
  const qty = e.input && e.input.quantity != null ? ' x' + e.input.quantity : '';

  console.log(
    '  ' + pad(e.seq, 4) + C.dim + pad(time, 10) + C.reset +
    pad(e.tool, 20) + color + pad(e.outcome, 10) + C.reset +
    pad(detail + qty, 34) + C.dim + String(e.hash || '').slice(0, 12) + '…' + C.reset
  );

  if (e.reasoning) {
    console.log(C.dim + '      "' + e.reasoning + '"' + C.reset);
  }
}

console.log('');

const result = auditLog.verifyChain();
if (result.valid) {
  console.log(
    C.green + C.bold + '  ✓ CHAIN INTACT' + C.reset +
    C.dim + '  ' + result.entries + ' records, none altered since they were written' + C.reset
  );
} else {
  console.log(C.red + C.bold + '  ✗ TAMPERED — record #' + result.brokenAt + C.reset);
  console.log(C.red + '    ' + result.detail + C.reset);
  console.log(C.dim + '    reason: ' + result.reason + C.reset);
}
console.log('');
process.exit(result.valid ? 0 : 1);
