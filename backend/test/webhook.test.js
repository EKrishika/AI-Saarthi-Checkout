'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyWebhookSignature } = require('../src/razorpay/webhook');

test('accepts a correctly-signed payload', () => {
  const secret = 'test_secret';
  const body = Buffer.from(JSON.stringify({ event: 'payment_link.paid' }));
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, signature, secret), true);
});

test('rejects a tampered payload', () => {
  const secret = 'test_secret';
  const body = Buffer.from(JSON.stringify({ event: 'payment_link.paid' }));
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const tampered = Buffer.from(JSON.stringify({ event: 'payment_link.paid', amount: 999999999 }));
  assert.equal(verifyWebhookSignature(tampered, signature, secret), false);
});

test('rejects a wrong secret', () => {
  const body = Buffer.from(JSON.stringify({ event: 'payment_link.paid' }));
  const signature = crypto.createHmac('sha256', 'right_secret').update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, signature, 'wrong_secret'), false);
});

test('rejects when any input is missing', () => {
  assert.equal(verifyWebhookSignature(null, 'sig', 'secret'), false);
  assert.equal(verifyWebhookSignature(Buffer.from('x'), null, 'secret'), false);
  assert.equal(verifyWebhookSignature(Buffer.from('x'), 'sig', null), false);
});
