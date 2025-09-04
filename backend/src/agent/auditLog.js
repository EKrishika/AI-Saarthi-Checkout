'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// AUDIT_LOG_PATH lets tests point at their own file. node --test runs each
// test file in its own process, so setting it before require() fully isolates
// a suite that truncates the log from suites reading the real one.
const LOG_PATH =
  process.env.AUDIT_LOG_PATH || path.join(__dirname, '..', '..', 'data', 'audit.jsonl');
const GENESIS = '0'.repeat(64);

/**
 * Append-only, hash-chained audit trail. Every tool call the agent makes —
 * allowed or rejected — is written here before its result is returned to the
 * conversation.
 *
 * Append-only on its own is a weak claim: `audit.jsonl` is a plain text file
 * and anyone with an editor can rewrite it. So each entry also carries the
 * hash of the entry before it, and its own hash over (seq, ts, prevHash,
 * payload). That makes the log *tamper-evident* rather than merely
 * append-only: changing any field of any historical entry breaks that entry's
 * hash, and re-hashing it to compensate breaks every `prevHash` after it.
 *
 * `verifyChain()` recomputes the whole chain and reports the first entry that
 * doesn't hold, which is what `GET /api/audit/verify` exposes. That
 * turns "you can trust this record" from an assertion in a README into
 * something a reviewer can check for themselves.
 */

/** Deterministic serialization — key order must not affect the hash. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') +
    '}'
  );
}

function hashEntry(body) {
  return crypto.createHash('sha256').update(canonicalize(body), 'utf8').digest('hex');
}

/** Cached chain head so a normal append doesn't re-read the whole file. */
let head = null;

function readRawLines() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
}

function currentHead() {
  if (head) return head;
  const entries = readAll();
  head = entries.length ? entries[entries.length - 1].hash : GENESIS;
  return head;
}

function nextSeq() {
  const entries = readAll();
  return entries.length ? entries[entries.length - 1].seq + 1 : 1;
}

function record(entry) {
  const prevHash = currentHead();
  const body = Object.assign({ seq: nextSeq(), ts: new Date().toISOString(), prevHash }, entry);
  const hash = hashEntry(body);
  const line = JSON.stringify(Object.assign({}, body, { hash })) + '\n';

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, line, 'utf8');
  head = hash;
  return hash;
}

function readAll() {
  const entries = [];
  for (const line of readRawLines()) {
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      // A half-written final line (process killed mid-append) must not take the
      // audit endpoint down with it — skip it and return the rest. The UI polls
      // this every 600ms during a turn, so a 500 here would blank the panel
      // mid-demo over a line that isn't even part of the current session.
    }
  }
  return entries;
}

function readForSession(sessionId) {
  return readAll().filter((e) => e.sessionId === sessionId);
}

/**
 * Recomputes the chain from genesis. Returns the first place it breaks, if
 * any, so a reviewer can see *which* record was altered rather than just that
 * something is wrong.
 */
function verifyChain() {
  const entries = readAll();
  let expectedPrev = GENESIS;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const stored = entry.hash;
    const body = Object.assign({}, entry);
    delete body.hash;

    if (entry.prevHash !== expectedPrev) {
      return {
        valid: false,
        entries: entries.length,
        brokenAt: entry.seq != null ? entry.seq : i + 1,
        reason: 'BROKEN_LINK',
        detail:
          'Entry ' + (entry.seq != null ? entry.seq : i + 1) +
          ' does not point at the previous entry — a record was inserted, removed or reordered.',
      };
    }
    if (hashEntry(body) !== stored) {
      return {
        valid: false,
        entries: entries.length,
        brokenAt: entry.seq != null ? entry.seq : i + 1,
        reason: 'CONTENT_ALTERED',
        detail:
          'Entry ' + (entry.seq != null ? entry.seq : i + 1) +
          ' does not match its own hash — its contents were modified after it was written.',
      };
    }
    expectedPrev = stored;
  }

  return { valid: true, entries: entries.length, head: expectedPrev, reason: 'CHAIN_INTACT' };
}

/** Test seam: forget the cached head so a cleared log re-reads from disk. */
function _resetHeadCache() {
  head = null;
}

module.exports = {
  record,
  readAll,
  readForSession,
  verifyChain,
  canonicalize,
  hashEntry,
  LOG_PATH,
  GENESIS,
  _resetHeadCache,
};
