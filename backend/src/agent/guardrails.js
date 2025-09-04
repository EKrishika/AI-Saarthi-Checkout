'use strict';

/**
 * Bounded-operations guardrails. This module is the single place that
 * decides whether an agent-proposed action is allowed to execute. It
 * has no knowledge of the LLM, prompts, or conversation — it only
 * looks at structured tool calls, so it stays testable and auditable
 * independent of model behaviour.
 *
 * Design principle: guardrails FAIL CLOSED. If something is ambiguous
 * or a check can't be evaluated, the action is rejected rather than
 * allowed through.
 */

const mandate = require('./mandate');

const ALLOWED_TOOLS = new Set([
  'search_catalog',
  'get_product',
  'add_to_cart',
  'remove_from_cart',
  'view_cart',
  'summarize_order',
  'create_checkout',
  'check_payment_status',
]);

const MAX_ORDER_VALUE_PAISE = (Number(process.env.MAX_ORDER_VALUE_INR) || 50000) * 100;
const MAX_ITEM_QUANTITY = Number(process.env.MAX_ITEM_QUANTITY) || 10;

class GuardrailViolation extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuardrailViolation';
    this.code = code;
  }
}

function assertToolAllowed(toolName) {
  if (!ALLOWED_TOOLS.has(toolName)) {
    throw new GuardrailViolation(
      'TOOL_NOT_WHITELISTED',
      `"${toolName}" is not in the agent's allowed tool set. Refusing to execute.`
    );
  }
}

function assertQuantityBounded(quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new GuardrailViolation('INVALID_QUANTITY', 'Quantity must be a positive integer.');
  }
  if (quantity > MAX_ITEM_QUANTITY) {
    throw new GuardrailViolation(
      'QUANTITY_CAP_EXCEEDED',
      `Requested quantity (${quantity}) exceeds the per-item cap of ${MAX_ITEM_QUANTITY}. ` +
        `A human needs to raise this limit before the agent can proceed.`
    );
  }
}

function assertOrderValueBounded(totalPaise) {
  if (totalPaise > MAX_ORDER_VALUE_PAISE) {
    throw new GuardrailViolation(
      'ORDER_VALUE_CAP_EXCEEDED',
      `Order total (₹${(totalPaise / 100).toLocaleString('en-IN')}) exceeds the agent's ` +
        `per-transaction cap of ₹${(MAX_ORDER_VALUE_PAISE / 100).toLocaleString('en-IN')}. ` +
        `This requires human checkout instead.`
    );
  }
}

function assertCartNotEmpty(cart) {
  if (!cart || cart.length === 0) {
    throw new GuardrailViolation('EMPTY_CART', 'Cannot check out an empty cart.');
  }
}

/**
 * Checkout is the one irreversible, money-moving action the agent can
 * take. It requires an explicit `confirmed: true` flag that the LLM
 * may only set after it has shown the user a summarize_order result
 * in this same session — enforced by the caller (agent.js) checking
 * `session.hasSummarized` before honouring this flag. This function
 * only checks the flag itself; the "was it actually shown" check is
 * session-state, kept in agent.js so this module stays pure.
 */
function assertCheckoutConfirmed(confirmed) {
  if (confirmed !== true) {
    throw new GuardrailViolation(
      'CONFIRMATION_REQUIRED',
      'create_checkout requires confirmed=true. The agent must summarize the order and ' +
        'receive explicit user confirmation before creating a payment link.'
    );
  }
}

/**
 * Checkout authority, the two ways it can be granted.
 *
 * ATTENDED   — a human is in the conversation. They must have been shown a
 *              summarize_order result and explicitly agreed to it. The human
 *              *is* the authority.
 * UNATTENDED — nobody is watching. Authority comes entirely from a signed
 *              mandate issued before the run started, re-verified here on
 *              every spend. This is the case the caps actually exist for.
 *
 * Both paths converge on MAX_ORDER_VALUE_PAISE, the merchant's own hard
 * ceiling: a mandate can narrow what the agent may do, never widen it beyond
 * what the merchant configured. Effective authority is the intersection of
 * merchant policy and buyer grant.
 */
function assertCheckoutAuthorized(context) {
  const ctx = context || {};
  const totalPaise = ctx.totalPaise || 0;

  // Merchant ceiling applies in both modes, first, unconditionally.
  assertOrderValueBounded(totalPaise);

  if (ctx.mode === 'unattended') {
    assertMandateCovers(ctx.mandate, ctx.usage, totalPaise, ctx.categories);
    return { authority: 'mandate', mandateId: ctx.mandate.id };
  }

  assertCheckoutConfirmed(ctx.confirmed);
  if (!ctx.hasSummarizedOrder) {
    throw new GuardrailViolation(
      'SUMMARY_NOT_SHOWN',
      'create_checkout was called before summarize_order was shown to the user in this session.'
    );
  }
  return { authority: 'human_confirmation' };
}

/**
 * Every mandate check, in one place, evaluated fresh on every spend. Ordered
 * so the failure a reviewer most wants to see comes first: a forged or
 * widened mandate is a different kind of problem from simply running out of
 * budget, and the audit log should say which happened.
 */
function assertMandateCovers(grant, usage, totalPaise, categories) {
  if (!grant) {
    throw new GuardrailViolation(
      'NO_MANDATE',
      'Unattended checkout requires a signed spend mandate. None was presented.'
    );
  }
  if (!mandate.verifySignature(grant)) {
    throw new GuardrailViolation(
      'MANDATE_SIGNATURE_INVALID',
      'The signature on this spend mandate does not match its contents — it was altered ' +
        'after it was issued. Refusing to spend against it.'
    );
  }
  if (mandate.isExpired(grant)) {
    throw new GuardrailViolation(
      'MANDATE_EXPIRED',
      `The spend mandate expired at ${grant.expiresAt}. A human needs to issue a new one.`
    );
  }

  const used = usage || { spentPaise: 0, transactions: 0 };

  // No `> 0` escape hatch here on purpose. Treating maxTransactions === 0 as
  // "unlimited" would make the most restrictive possible grant the most
  // permissive one — a fail-open on the control that bounds how many times the
  // agent can reach for money. Zero authorised means zero.
  if (used.transactions >= grant.maxTransactions) {
    throw new GuardrailViolation(
      'MANDATE_TRANSACTIONS_EXHAUSTED',
      `This mandate authorised ${grant.maxTransactions} transaction(s) and all have been used.`
    );
  }
  if (totalPaise > grant.maxPerOrderPaise) {
    throw new GuardrailViolation(
      'MANDATE_PER_ORDER_EXCEEDED',
      `Order total (${formatInr(totalPaise)}) exceeds the mandate's per-order limit of ` +
        `${formatInr(grant.maxPerOrderPaise)}.`
    );
  }
  if ((used.spentPaise || 0) + totalPaise > grant.maxTotalPaise) {
    throw new GuardrailViolation(
      'MANDATE_BUDGET_EXCEEDED',
      `This order (${formatInr(totalPaise)}) would take total spend past the mandate's ` +
        `${formatInr(grant.maxTotalPaise)} budget — ${formatInr(grant.maxTotalPaise - (used.spentPaise || 0))} remains.`
    );
  }

  const allowed = grant.allowedCategories || [];
  if (allowed.length) {
    const offending = (categories || []).filter((c) => !allowed.includes(c));
    if (offending.length) {
      throw new GuardrailViolation(
        'MANDATE_CATEGORY_NOT_ALLOWED',
        `The mandate covers ${allowed.join(', ')} — it does not authorise ` +
          `${[...new Set(offending)].join(', ')}.`
      );
    }
  }
}

function formatInr(paise) {
  return '₹' + (paise / 100).toLocaleString('en-IN');
}

module.exports = {
  ALLOWED_TOOLS,
  assertCheckoutAuthorized,
  assertMandateCovers,
  MAX_ORDER_VALUE_PAISE,
  MAX_ITEM_QUANTITY,
  GuardrailViolation,
  assertToolAllowed,
  assertQuantityBounded,
  assertOrderValueBounded,
  assertCartNotEmpty,
  assertCheckoutConfirmed,
};
