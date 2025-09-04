'use strict';

const { v4: uuidv4 } = require('uuid');
const sessionStore = require('./sessionStore');
const mandate = require('./mandate');
const auditLog = require('./auditLog');
const { handleUserMessage } = require('./agent');
const { cartDetail, cartTotalPaise } = require('./tools');

/**
 * Unattended runs: the agent shops and pays with nobody watching.
 *
 * This is the case the guardrails actually exist for. There is no human turn
 * to approve the payment, so `create_checkout` cannot fall back to "the user
 * said yes" — its only route to authority is the signed mandate, re-verified
 * on every spend inside guardrails.js.
 *
 * The run itself is bounded too: a goal is one shot at one purchase, capped at
 * MAX_STEPS agent turns. An agent that can't finish inside that budget stops
 * and says so rather than looping against a live payments API.
 */

const MAX_STEPS = 4;

const UNATTENDED_BRIEF = `Buyer details for create_checkout: name {{SUBJECT}}, contact {{CONTACT}}.`;

/**
 * Starts an unattended run against a freshly issued mandate.
 * Returns the mandate, a step-by-step trace, and whatever the agent ended up
 * buying (or the guardrail that stopped it).
 */
async function runUnattended(options) {
  const opts = options || {};
  const goal = String(opts.goal || '').trim();
  if (!goal) {
    return { error: 'A goal is required, e.g. "buy noise-cancelling earbuds".' };
  }

  const grant = mandate.issue({
    subject: opts.subject || 'Buyer',
    maxTotalPaise: opts.maxTotalPaise,
    maxPerOrderPaise: opts.maxPerOrderPaise,
    allowedCategories: opts.allowedCategories,
    maxTransactions: opts.maxTransactions,
    ttlMinutes: opts.ttlMinutes,
  });

  const sessionId = opts.sessionId || 'unattended-' + uuidv4().slice(0, 8);
  sessionStore.reset(sessionId);
  const session = sessionStore.getOrCreate(sessionId);
  session.mode = 'unattended';
  session.mandate = grant;

  auditLog.record({
    sessionId,
    tool: 'mandate_issued',
    outcome: 'success',
    result: {
      mandateId: grant.id,
      subject: grant.subject,
      maxTotalPaise: grant.maxTotalPaise,
      maxPerOrderPaise: grant.maxPerOrderPaise,
      allowedCategories: grant.allowedCategories,
      maxTransactions: grant.maxTransactions,
      expiresAt: grant.expiresAt,
    },
    reasoning: 'Human granted the agent bounded spending authority before stepping away.',
  });

  const trace = [];
  let step = 0;
  let message = `${UNATTENDED_BRIEF}\n\nGOAL: ${goal}`;

  while (step++ < MAX_STEPS) {
    const turn = await handleUserMessage(session, message);
    trace.push({
      step,
      reply: turn.reply,
      toolCalls: (turn.toolCalls || []).map((c) => ({
        tool: c.tool,
        outcome: c.outcome,
        code: c.code,
        message: c.message,
      })),
    });

    if (session.order) break; // bought something — done
    const blocked = (turn.toolCalls || []).some(
      (c) => c.outcome === 'rejected' && String(c.code || '').startsWith('MANDATE_')
    );
    if (blocked) break; // the mandate stopped it — that IS the result

    message = 'Continue working toward the goal. Do not ask questions.';
  }

  return {
    sessionId,
    goal,
    mandate: grant,
    usage: session.mandateUsage,
    remaining: mandate.remaining(grant, session.mandateUsage),
    steps: trace,
    cart: cartDetail(session.cart),
    cartTotalPaise: cartTotalPaise(session.cart),
    order: session.order,
    outcome: session.order ? 'purchased' : 'stopped',
  };
}

module.exports = { runUnattended, MAX_STEPS };
