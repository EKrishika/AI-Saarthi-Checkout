'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// Isolated log file: this suite truncates and rewrites it, and must not race
// with the suites that assert against the real audit trail.
process.env.AUDIT_LOG_PATH = require('path').join(
  require('os').tmpdir(),
  'signet-audit-chain-test.jsonl'
);

const auditLog = require('../src/agent/auditLog');

function freshLog() {
  fs.mkdirSync(require('path').dirname(auditLog.LOG_PATH), { recursive: true });
  fs.writeFileSync(auditLog.LOG_PATH, '', 'utf8');
  auditLog._resetHeadCache();
}

function seed(n) {
  freshLog();
  for (let i = 0; i < n; i++) {
    auditLog.record({ sessionId: 'chain-test', tool: 'view_cart', outcome: 'success', result: { i } });
  }
}

test('each entry chains to the one before it, starting from genesis', () => {
  seed(3);
  const entries = auditLog.readAll();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].prevHash, auditLog.GENESIS);
  assert.equal(entries[1].prevHash, entries[0].hash);
  assert.equal(entries[2].prevHash, entries[1].hash);
  assert.deepEqual(
    entries.map((e) => e.seq),
    [1, 2, 3]
  );
});

test('an untouched chain verifies', () => {
  seed(4);
  const result = auditLog.verifyChain();
  assert.equal(result.valid, true);
  assert.equal(result.entries, 4);
  assert.equal(result.reason, 'CHAIN_INTACT');
});

/**
 * The claim this whole design exists to support. Append-only alone doesn't
 * stop anyone editing a plain text file — hash chaining is what makes an edit
 * *detectable*. If this test ever fails, the README is lying.
 */
test('editing a historical entry is detected, and the altered record is named', () => {
  seed(4);
  const lines = fs.readFileSync(auditLog.LOG_PATH, 'utf8').split('\n').filter(Boolean);

  // Rewrite entry 2's payload, leaving its stored hash in place — exactly what
  // someone covering their tracks in a text editor would do.
  const tampered = JSON.parse(lines[1]);
  tampered.outcome = 'rejected';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(auditLog.LOG_PATH, lines.join('\n') + '\n', 'utf8');

  const result = auditLog.verifyChain();
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CONTENT_ALTERED');
  assert.equal(result.brokenAt, 2);
});

test('re-hashing an edited entry still breaks the chain at the next link', () => {
  seed(4);
  const lines = fs.readFileSync(auditLog.LOG_PATH, 'utf8').split('\n').filter(Boolean);

  // A more determined edit: change the content AND recompute that entry's own
  // hash so it self-verifies. Entry 3's prevHash no longer matches, so the
  // forgery still surfaces — that's the point of chaining rather than just
  // hashing each row independently.
  const entry = JSON.parse(lines[1]);
  entry.outcome = 'rejected';
  delete entry.hash;
  const rehashed = Object.assign({}, entry, { hash: auditLog.hashEntry(entry) });
  lines[1] = JSON.stringify(rehashed);
  fs.writeFileSync(auditLog.LOG_PATH, lines.join('\n') + '\n', 'utf8');

  const result = auditLog.verifyChain();
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'BROKEN_LINK');
  assert.equal(result.brokenAt, 3);
});

test('deleting an entry from the middle is detected', () => {
  seed(4);
  const lines = fs.readFileSync(auditLog.LOG_PATH, 'utf8').split('\n').filter(Boolean);
  lines.splice(1, 1);
  fs.writeFileSync(auditLog.LOG_PATH, lines.join('\n') + '\n', 'utf8');

  const result = auditLog.verifyChain();
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 3);
});

test('hashing is independent of key order', () => {
  const a = auditLog.hashEntry({ seq: 1, tool: 'x', outcome: 'success' });
  const b = auditLog.hashEntry({ outcome: 'success', seq: 1, tool: 'x' });
  assert.equal(a, b);
});

test('a torn final line does not break verification of the rest', () => {
  seed(3);
  fs.appendFileSync(auditLog.LOG_PATH, '{"seq":4,"tool":"view_c', 'utf8');
  const result = auditLog.verifyChain();
  assert.equal(result.valid, true);
  assert.equal(result.entries, 3);
});

test.after(() => freshLog());
