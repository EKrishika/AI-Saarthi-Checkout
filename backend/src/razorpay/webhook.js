'use strict';

const crypto = require('crypto');

/**
 * Verifies a Razorpay webhook signature using the same HMAC-SHA256
 * scheme the SDK's validateWebhookSignature helper uses, reimplemented
 * directly against the raw request body so we control exactly what
 * bytes get hashed (Express body-parsing can otherwise re-serialize
 * JSON and silently break signature verification).
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyWebhookSignature };
