'use strict';

const express = require('express');
const auditLog = require('../agent/auditLog');

const router = express.Router();

// Declared BEFORE '/audit/:sessionId' — Express matches in registration order,
// so the param route would otherwise swallow this as sessionId="verify".
//
// Recomputes the hash chain over the whole log and reports the first entry
// that doesn't hold. "Append-only" is a claim; this is how a reviewer checks
// it. Edit any line of backend/data/audit.jsonl and this goes red, naming the
// record that was altered.
router.get('/audit/verify', (req, res) => {
  res.json(auditLog.verifyChain());
});

// Exposes the audit trail for a session so the UI (or a reviewer) can
// see exactly which tools ran, what the guardrails decided, and why —
// the "explainable transactions" requirement made inspectable, not
// just asserted in a README.
router.get('/audit/:sessionId', (req, res) => {
  res.json({ entries: auditLog.readForSession(req.params.sessionId) });
});

module.exports = router;
