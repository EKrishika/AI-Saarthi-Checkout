'use strict';

const { TOOL_SCHEMAS, executeTool, cartDetail, cartTotalPaise } = require('./tools');
const llm = require('./llm');
const { getEffort } = require('./model');
const sessionStore = require('./sessionStore');
const auditLog = require('./auditLog');

const SHARED_RULES = `You are Signet, a checkout agent for a demo storefront, built on Razorpay's TEST-mode payment APIs.

Hard rules — these are also enforced in code, but you must follow them anyway:
1. Every claim about price, stock or order status must come from a tool result. Never invent numbers.
2. Always give create_checkout a one-sentence "reasoning" string: why is checking out correct right now?
3. If a tool returns an error, explain it in plain language and suggest a next step. Never pretend an error didn't happen.
4. Do NOT refuse an action yourself because you predict it will be blocked. If asked to add 500 of something, call add_to_cart with 500 and let the guardrails decide. An action you silently declined leaves no record, which defeats the point of the audit log.
5. Stay within the demo catalog. If asked for something not in it, say so and offer to search again.
6. Be concise — two or three short sentences. Never use markdown tables; write prices inline as plain text.

After every tool call, briefly say what you did and why, in your own words — this is what makes the transaction explainable.`;

/** A human is in the conversation, and their explicit yes is the authority. */
const ATTENDED_RULES = `
You are ASSISTED: a human is in this conversation and authorises each payment.
Before calling create_checkout you MUST call summarize_order, show the user the summary, and wait for their explicit confirmation ("yes", "confirm", "go ahead"). Only then may you call create_checkout with confirmed=true.`;

/**
 * Nobody is watching. Authority comes from the signed mandate, which
 * guardrails.js verifies on every spend — so the model must NOT sit waiting for
 * a confirmation that will never arrive. Left on the attended rules, an
 * unattended run stalls asking an empty room to say "yes", and the mandate
 * never gets the chance to allow or refuse the spend.
 */
const UNATTENDED_RULES = `
You are running UNATTENDED. There is NO human in this conversation. Nobody will answer a question, and nobody will confirm anything.

Your authority comes from a signed spend mandate that was issued before this run started, not from user confirmation. Proceed without waiting for approval:
1. search_catalog for the goal.
2. add_to_cart with the single best match.
3. summarize_order.
4. create_checkout with confirmed=true and a one-sentence reasoning.

Do not ask questions and do not wait for a confirmation — there is nobody to give one. If the mandate does not cover the purchase, create_checkout will be rejected with a MANDATE_* code; report that outcome plainly and stop, rather than retrying the same call.`;

function systemPromptFor(session) {
  return SHARED_RULES + (session && session.mode === 'unattended' ? UNATTENDED_RULES : ATTENDED_RULES);
}

// Kept for tests and docs that reference the attended prompt directly.
const SYSTEM_PROMPT = SHARED_RULES + ATTENDED_RULES;

const MAX_TOOL_ROUNDS = 6; // bounded agent loop — never spins forever

/**
 * The cart snapshot the UI renders. session.cart is deliberately minimal
 * ({productId, quantity}) so it stays the single source of truth; prices and
 * names are resolved from the catalog at read time, so the sidebar can never
 * display a stale price that disagrees with what checkout actually charges.
 */
function snapshot(session, extra) {
  return Object.assign(
    {
      cart: cartDetail(session.cart),
      cartTotalPaise: cartTotalPaise(session.cart),
      order: session.order,
    },
    extra
  );
}

/**
 * Turns an SDK error into something a buyer can act on. A raw
 * "401 authentication_error" in a chat bubble helps nobody; "the key isn't
 * configured" tells whoever is running the demo exactly what to fix.
 */
function explainLlmError(err) {
  const status = err && err.status;
  if (status === 401 || status === 403) {
    return `I can't reach my language model — the ${llm.providerConfig().label} API key looks missing or invalid. Check ${llm.providerConfig().keyEnv} in backend/.env.`;
  }
  if (status === 429) {
    return "I'm being rate-limited by the language model right now. Give it a few seconds and send that again.";
  }
  if (status === 404) {
    return `The configured model (${llm.getModel()}) wasn't found on ${llm.providerConfig().label}. Check LLM_MODEL in backend/.env.`;
  }
  if (status >= 500) {
    return 'The language model service is having a moment. Nothing was charged — try that again shortly.';
  }
  return `I couldn't reach the language model just now (${(err && err.message) || 'unknown error'}). Please try again in a moment.`;
}

/**
 * Runs one user turn to completion: sends the message, executes any
 * tool calls Claude makes (bounded to MAX_TOOL_ROUNDS), and returns
 * the assistant's final text reply plus a snapshot of session state
 * for the UI.
 */
async function handleUserMessage(session, userText) {
  // Check configuration inside the guarded path: an unconfigured key is the
  // single most likely first-run failure, and it deserves the most specific
  // message, not the generic catch-all in routes/chat.js.
  if (!llm.isConfigured()) {
    const config = llm.providerConfig();
    const message =
      `I'm not configured yet — ${config.keyEnv} is missing for the ${config.label} provider. ` +
      `Get a free key at ${config.signupUrl}, add it to backend/.env, and restart the server.`;
    auditLog.record({
      sessionId: session.id,
      tool: 'llm_call',
      outcome: 'error',
      code: 'NOT_CONFIGURED',
      message,
    });
    return snapshot(session, { reply: message, toolCalls: [] });
  }

  session.history.push({ role: 'user', content: userText });
  sessionStore.touch(session);

  let roundsLeft = MAX_TOOL_ROUNDS;
  let finalText = '';
  // Everything the agent actually did this turn, in order. The UI renders
  // this inline (tool chips, product cards, guardrail rejections) so the
  // explainability isn't buried in a side panel the viewer has to squint at.
  const toolCalls = [];

  while (roundsLeft-- > 0) {
    let response;
    try {
      response = await llm.createMessage({
        maxTokens: 900,
        // Low effort where the provider supports it: this is short-message tool
        // routing, not hard reasoning, and a checkout chat lives or dies on
        // response latency.
        effort: getEffort(),
        system: systemPromptFor(session),
        tools: TOOL_SCHEMAS,
        messages: session.history,
      });
    } catch (err) {
      // Graceful failure: the LLM call itself failed (rate limit, network,
      // bad key). Don't crash the request — tell the user plainly.
      auditLog.record({
        sessionId: session.id,
        tool: 'llm_call',
        outcome: 'error',
        message: err.message,
      });
      finalText = explainLlmError(err);
      return snapshot(session, { reply: finalText, toolCalls });
    }

    const textParts = response.content.filter((b) => b.type === 'text').map((b) => b.text);
    finalText = textParts.join('\n').trim() || finalText;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');

    session.history.push({ role: 'assistant', content: response.content });

    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      break;
    }

    // Tool calls in one assistant turn are independent — run them
    // concurrently and return every tool_result in a single user message.
    const results = await Promise.all(
      toolUses.map((toolUse) => executeTool(toolUse.name, toolUse.input || {}, session))
    );

    const toolResults = toolUses.map((toolUse, i) => {
      const result = results[i];
      toolCalls.push({
        tool: toolUse.name,
        input: toolUse.input || {},
        // Classify on the error CODE, not the message: a provider error with an
        // empty description would otherwise be reported as a success.
        outcome: !result || !('error' in result)
          ? 'success'
          : result.code && result.code !== 'UNEXPECTED_ERROR'
            ? 'rejected'
            : 'error',
        code: result && result.code,
        message: result && result.error,
        result,
      });
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
        is_error: Boolean(result && result.error),
      };
    });
    session.history.push({ role: 'user', content: toolResults });
  }

  if (roundsLeft <= 0) {
    finalText =
      finalText ||
      "I've taken several steps on this and want to check in before continuing — could you confirm what you'd like next?";
  }

  return snapshot(session, { reply: finalText, toolCalls });
}

module.exports = { handleUserMessage, SYSTEM_PROMPT, systemPromptFor, getModel: llm.getModel };
