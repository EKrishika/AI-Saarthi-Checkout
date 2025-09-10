'use strict';

const express = require('express');
const { verifyWebhookSignature } = require('../razorpay/webhook');
const auditLog = require('../agent/auditLog');

const router = express.Router();

// Mounted with express.raw() in server.js so req.body is the exact raw
// bytes Razorpay signed — verifying against a re-serialized JSON object
// is a common bug that silently breaks signature checks.
router.post('/webhooks/razorpay', (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  const isValid = verifyWebhookSignature(req.body, signature, secret);
  if (!isValid) {
    auditLog.record({ sessionId: 'webhook', tool: 'webhook_receive', outcome: 'rejected', code: 'BAD_SIGNATURE' });
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    auditLog.record({ sessionId: 'webhook', tool: 'webhook_receive', outcome: 'error', message: 'Invalid JSON payload' });
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  auditLog.record({
    sessionId: 'webhook',
    tool: 'webhook_receive',
    outcome: 'success',
    result: { event: payload.event, referenceId: payload.payload?.payment_link?.entity?.reference_id },
  });

  // Acknowledge quickly; a production build would fan this out to
  // update an order-status store keyed by reference_id / payment_link.id.
  res.status(200).json({ received: true });
});

module.exports = router;
