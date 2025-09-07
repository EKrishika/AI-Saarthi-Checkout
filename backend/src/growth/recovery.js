'use strict';

const catalog = require('../catalog');
const auditLog = require('../agent/auditLog');
const razorpay = require('../razorpay/client');
const { cartDetail, cartTotalPaise } = require('../agent/tools');

/**
 * Abandoned-cart recovery — the "Growth" half of the track.
 *
 * A conversational checkout produces a signal a page-based funnel doesn't: the
 * agent knows exactly what the buyer asked for, what it put in the cart, and
 * which step they dropped at. That makes recovery specific rather than a
 * generic "you left something behind" blast — and because the cart is already
 * priced and validated, recovery can hand back a live payment link instead of
 * a link back into the funnel.
 *
 * A session counts as abandoned when it has a non-empty cart, no completed
 * order, and no activity for `staleAfterMinutes`.
 */

const DEFAULT_STALE_MINUTES = 15;

function minutesSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - Date.parse(iso)) / 60000;
}

/** Where in the funnel the buyer stopped — drives what recovery should say. */
function dropOffStage(session) {
  if (session.order) return 'completed';
  if (session.hasSummarizedOrder) return 'abandoned_at_confirmation';
  if (session.cart.length) return 'abandoned_with_cart';
  return 'abandoned_before_cart';
}

function listAbandoned(sessions, staleAfterMinutes) {
  const stale = staleAfterMinutes == null ? DEFAULT_STALE_MINUTES : Number(staleAfterMinutes);
  const out = [];

  for (const session of sessions) {
    if (session.order) continue;
    if (!session.cart || !session.cart.length) continue;
    const idle = minutesSince(session.lastActivityAt || session.createdAt);
    if (idle < stale) continue;

    const totalPaise = cartTotalPaise(session.cart);
    out.push({
      sessionId: session.id,
      stage: dropOffStage(session),
      idleMinutes: Math.round(idle),
      items: cartDetail(session.cart),
      recoverableValuePaise: totalPaise,
      recoverableValue: catalog.formatPrice(totalPaise),
      // A buyer who saw the summary and didn't say yes is one tap from paying;
      // one who never got there needs a different nudge. Rank accordingly.
      priority: session.hasSummarizedOrder ? 'high' : 'normal',
    });
  }

  return out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
    return b.recoverableValuePaise - a.recoverableValuePaise;
  });
}

function summarize(abandoned) {
  const totalPaise = abandoned.reduce((n, a) => n + a.recoverableValuePaise, 0);
  return {
    carts: abandoned.length,
    recoverableValuePaise: totalPaise,
    recoverableValue: catalog.formatPrice(totalPaise),
    highIntent: abandoned.filter((a) => a.priority === 'high').length,
  };
}

/** The nudge itself — specific to where they stopped and what they picked. */
function draftNudge(entry) {
  const names = entry.items.map((i) => `${i.quantity}× ${i.name}`).join(', ');
  if (entry.stage === 'abandoned_at_confirmation') {
    return (
      `You were one step from checking out ${names} (${entry.recoverableValue}). ` +
      `Your cart is still priced and ready — here's a payment link, no need to start over.`
    );
  }
  return (
    `You left ${names} in your cart (${entry.recoverableValue}). ` +
    `Still interested? Here's a link to finish up, or reply and I'll adjust the order.`
  );
}

/**
 * Turns one abandoned cart into a real, payable Razorpay link.
 *
 * Note this deliberately does NOT go through the agent's create_checkout: no
 * buyer confirmed anything and no mandate authorises it, so it must not book
 * spend or set session.order. It's a merchant-initiated offer the buyer can
 * still decline by simply not paying.
 */
async function recover(session) {
  const totalPaise = cartTotalPaise(session.cart);
  const items = cartDetail(session.cart);
  const entry = {
    sessionId: session.id,
    stage: dropOffStage(session),
    idleMinutes: Math.round(minutesSince(session.lastActivityAt || session.createdAt)),
    items,
    recoverableValuePaise: totalPaise,
    recoverableValue: catalog.formatPrice(totalPaise),
    priority: session.hasSummarizedOrder ? 'high' : 'normal',
  };

  const referenceId = `signet-recovery-${session.id}`;
  let link;
  try {
    link = await razorpay.createPaymentLink({
      amountPaise: totalPaise,
      description: `Signet — complete your order: ${items.map((i) => `${i.quantity}x ${i.name}`).join(', ')}`,
      customer: { name: 'Returning buyer' },
      referenceId,
      notes: { agent: 'signet-recovery', sessionId: session.id },
    });
  } catch (err) {
    auditLog.record({
      sessionId: session.id,
      tool: 'cart_recovery',
      outcome: 'error',
      message: err.message,
    });
    return { error: `Couldn't create a recovery link: ${err.message}` };
  }

  const nudge = draftNudge(entry);
  auditLog.record({
    sessionId: session.id,
    tool: 'cart_recovery',
    outcome: 'success',
    result: { stage: entry.stage, recoverableValuePaise: totalPaise, payUrl: link.short_url },
    reasoning: 'Cart went idle before checkout; offered a pre-priced payment link to recover the sale.',
  });

  return { sessionId: session.id, stage: entry.stage, nudge, payUrl: link.short_url, amount: entry.recoverableValue };
}

module.exports = { listAbandoned, summarize, draftNudge, recover, dropOffStage, DEFAULT_STALE_MINUTES };
