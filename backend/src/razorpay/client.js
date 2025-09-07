'use strict';

const Razorpay = require('razorpay');

let instance = null;

/**
 * Lazily-constructed singleton Razorpay client. Lazy so that unit tests
 * that never touch a real payment path don't need dummy env vars to
 * simply require() this file.
 */
function getClient() {
  if (instance) return instance;

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error(
      'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. Copy backend/.env.example ' +
        'to backend/.env and fill in your Razorpay TEST mode keys.'
    );
  }

  instance = new Razorpay({ key_id, key_secret });
  return instance;
}

/**
 * The Razorpay SDK rejects with a plain object ({statusCode, error:{...}}), not
 * an Error — so `err.message` is undefined and a naive catch reports an empty
 * "unexpected error" while the API actually told us exactly what was wrong
 * (e.g. "Recurring digits in customer contact are disallowed"). Normalise it so
 * the agent can explain the real reason to the buyer.
 */
function normalizeRazorpayError(err) {
  if (err instanceof Error && err.message) return err;
  const detail = err && err.error;
  const normalized = new Error(
    (detail && detail.description) || (err && err.message) || 'Razorpay rejected the request.'
  );
  normalized.statusCode = err && err.statusCode;
  normalized.razorpayCode = detail && detail.code;
  return normalized;
}

async function createPaymentLink({ amountPaise, description, customer, referenceId, notes }) {
  const client = getClient();
  try {
    return await client.paymentLink.create({
      amount: amountPaise,
      currency: 'INR',
      accept_partial: false,
      description,
      customer,
      notify: { sms: false, email: Boolean(customer && customer.email) },
      reminder_enable: false,
      reference_id: referenceId,
      notes,
      callback_url: process.env.CALLBACK_URL || undefined,
      callback_method: process.env.CALLBACK_URL ? 'get' : undefined,
    });
  } catch (err) {
    throw normalizeRazorpayError(err);
  }
}

async function fetchPaymentLink(paymentLinkId) {
  const client = getClient();
  try {
    return await client.paymentLink.fetch(paymentLinkId);
  } catch (err) {
    throw normalizeRazorpayError(err);
  }
}

module.exports = { getClient, createPaymentLink, fetchPaymentLink, normalizeRazorpayError };
