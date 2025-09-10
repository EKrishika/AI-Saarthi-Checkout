'use strict';

const express = require('express');
const { runUnattended } = require('../agent/autonomous');
const mandate = require('../agent/mandate');
const sessionStore = require('../agent/sessionStore');
const recovery = require('../growth/recovery');

const router = express.Router();

/**
 * Issues a signed spend mandate without running anything — lets a reviewer
 * inspect the grant, and lets the UI show it before the agent is let loose.
 */
router.post('/mandate', (req, res) => {
  const body = req.body || {};
  const grant = mandate.issue({
    subject: body.subject,
    maxTotalPaise: body.maxTotalPaise,
    maxPerOrderPaise: body.maxPerOrderPaise,
    allowedCategories: body.allowedCategories,
    maxTransactions: body.maxTransactions,
    ttlMinutes: body.ttlMinutes,
  });
  res.json({ mandate: grant, remaining: mandate.remaining(grant, null) });
});

/**
 * Runs the agent with no human in the loop. Long-ish (several model turns),
 * so it returns the full trace at the end rather than streaming — the audit
 * endpoint is what the UI polls for live progress.
 */
router.post('/unattended', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runUnattended({
      goal: body.goal,
      subject: body.subject,
      contact: body.contact,
      maxTotalPaise: body.maxTotalPaise,
      maxPerOrderPaise: body.maxPerOrderPaise,
      allowedCategories: body.allowedCategories,
      maxTransactions: body.maxTransactions,
      ttlMinutes: body.ttlMinutes,
      sessionId: body.sessionId,
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('Unattended run failed:', err);
    res.status(200).json({
      outcome: 'error',
      error: 'The unattended run failed before completing. Nothing was charged.',
      detail: err.message,
    });
  }
});

/** Abandoned carts, ranked by how recoverable they are. */
router.get('/growth/abandoned', (req, res) => {
  const abandoned = recovery.listAbandoned(sessionStore.listAll(), req.query.staleAfterMinutes);
  res.json({ summary: recovery.summarize(abandoned), carts: abandoned });
});

/** Turns one abandoned cart into a live payment link plus a drafted nudge. */
router.post('/growth/recover/:sessionId', async (req, res) => {
  const session = sessionStore.listAll().find((s) => s.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'No such session.' });
  if (session.order) return res.status(400).json({ error: 'That session already completed an order.' });
  if (!session.cart.length) return res.status(400).json({ error: 'That session has an empty cart.' });

  const result = await recovery.recover(session);
  res.status(result.error ? 502 : 200).json(result);
});

module.exports = router;
