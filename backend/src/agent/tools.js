'use strict';

const { v4: uuidv4 } = require('uuid');
const catalog = require('../catalog');
const razorpay = require('../razorpay/client');
const guardrails = require('./guardrails');
const mandate = require('./mandate');
const auditLog = require('./auditLog');

/**
 * Tool schemas presented to Claude (Anthropic tool-use format). Keep
 * these narrow and literal — the fewer degrees of freedom a tool
 * exposes, the smaller the guardrail surface has to be.
 */
const TOOL_SCHEMAS = [
  {
    name: 'search_catalog',
    description:
      'Search the product catalog by free-text query (matches name, description, category, tags). Returns matching products with id, name, description, price, and stock. Read-only.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text, e.g. "keyboard" or "under 3000"' } },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Fetch a single product by its catalog id. Read-only.',
    input_schema: {
      type: 'object',
      properties: { productId: { type: 'string' } },
      required: ['productId'],
    },
  },
  {
    name: 'add_to_cart',
    description:
      'Add a product to the cart. Rejected if the quantity exceeds the per-item cap or the product does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
      },
      required: ['productId', 'quantity'],
    },
  },
  {
    name: 'remove_from_cart',
    description: 'Remove a product from the cart entirely.',
    input_schema: {
      type: 'object',
      properties: { productId: { type: 'string' } },
      required: ['productId'],
    },
  },
  {
    name: 'view_cart',
    description: 'Return the current cart contents and running total. Read-only.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'summarize_order',
    description:
      'Produce a human-readable order summary (items, quantities, total). MUST be called and shown to the user before create_checkout — this is what "confirmed" in create_checkout refers to.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_checkout',
    description:
      'Create a Razorpay TEST-mode payment link for the current cart and return the pay-now URL. This is the only action that moves toward real money movement, so it requires: a non-empty cart, a total under the configured cap, customer contact details, confirmed=true (only set this after the user has explicitly agreed to the summarize_order output in this conversation), and a one-sentence reasoning string explaining why checkout is happening now.',
    input_schema: {
      type: 'object',
      properties: {
        customerName: { type: 'string' },
        customerEmail: { type: 'string' },
        customerContact: { type: 'string', description: 'Phone number, e.g. +919876543210' },
        confirmed: { type: 'boolean' },
        reasoning: {
          type: 'string',
          description: 'One sentence: why is it correct to check out now, given the conversation so far?',
        },
      },
      required: ['customerName', 'customerContact', 'confirmed', 'reasoning'],
    },
  },
  {
    name: 'check_payment_status',
    description: "Check the status of the order's payment link (created / paid / expired / cancelled).",
    input_schema: { type: 'object', properties: {} },
  },
];

function cartTotalPaise(cart) {
  return cart.reduce((sum, item) => {
    const product = catalog.getById(item.productId);
    return sum + (product ? product.price_paise * item.quantity : 0);
  }, 0);
}

/** Distinct catalog categories in the cart — what a mandate scopes against. */
function cartCategories(cart) {
  const seen = new Set();
  for (const item of cart) {
    const product = catalog.getById(item.productId);
    if (product) seen.add(product.category);
  }
  return [...seen];
}

function cartDetail(cart) {
  return cart.map((item) => {
    const product = catalog.getById(item.productId);
    return {
      productId: item.productId,
      name: product ? product.name : 'UNKNOWN',
      quantity: item.quantity,
      lineTotalPaise: product ? product.price_paise * item.quantity : 0,
    };
  });
}

/**
 * Executes one tool call against session state. Every call — success
 * or guardrail rejection — is written to the audit trail with the
 * agent's own stated reasoning where one was provided, so the log
 * doubles as the "explainable transactions" record the track asks for.
 */
async function executeTool(toolName, input, session) {
  const auditBase = { sessionId: session.id, tool: toolName, input };

  try {
    guardrails.assertToolAllowed(toolName);

    let result;
    switch (toolName) {
      case 'search_catalog': {
        result = { products: catalog.search(input.query) };
        break;
      }
      case 'get_product': {
        const product = catalog.getById(input.productId);
        result = product ? { product } : { error: 'Product not found.' };
        break;
      }
      case 'add_to_cart': {
        guardrails.assertQuantityBounded(input.quantity);
        const product = catalog.getById(input.productId);
        if (!product) {
          result = { error: `No product with id "${input.productId}".` };
          break;
        }
        if (product.stock < input.quantity) {
          result = { error: `Only ${product.stock} units of "${product.name}" in stock.` };
          break;
        }
        const existing = session.cart.find((i) => i.productId === input.productId);
        if (existing) {
          guardrails.assertQuantityBounded(existing.quantity + input.quantity);
          existing.quantity += input.quantity;
        } else {
          session.cart.push({ productId: input.productId, quantity: input.quantity });
        }
        session.hasSummarizedOrder = false; // cart changed, prior summary is stale
        result = { cart: cartDetail(session.cart), totalPaise: cartTotalPaise(session.cart) };
        break;
      }
      case 'remove_from_cart': {
        session.cart = session.cart.filter((i) => i.productId !== input.productId);
        session.hasSummarizedOrder = false;
        result = { cart: cartDetail(session.cart), totalPaise: cartTotalPaise(session.cart) };
        break;
      }
      case 'view_cart': {
        result = { cart: cartDetail(session.cart), totalPaise: cartTotalPaise(session.cart) };
        break;
      }
      case 'summarize_order': {
        guardrails.assertCartNotEmpty(session.cart);
        const total = cartTotalPaise(session.cart);
        guardrails.assertOrderValueBounded(total);
        session.hasSummarizedOrder = true;
        result = { cart: cartDetail(session.cart), totalPaise: total, formattedTotal: catalog.formatPrice(total) };
        break;
      }
      case 'create_checkout': {
        guardrails.assertCartNotEmpty(session.cart);
        const total = cartTotalPaise(session.cart);

        // The single authority check for money movement. In an attended
        // session this is the human's explicit yes; in an unattended run it is
        // the signed mandate, re-verified here on every spend. Either way the
        // merchant's own ceiling applies first.
        const authority = guardrails.assertCheckoutAuthorized({
          mode: session.mode,
          confirmed: input.confirmed,
          hasSummarizedOrder: session.hasSummarizedOrder,
          mandate: session.mandate,
          usage: session.mandateUsage,
          totalPaise: total,
          categories: cartCategories(session.cart),
        });

        const referenceId = `signet-${session.id}-${uuidv4().slice(0, 8)}`;
        const items = cartDetail(session.cart);
        const description = items.map((i) => `${i.quantity}x ${i.name}`).join(', ');

        const link = await razorpay.createPaymentLink({
          amountPaise: total,
          description: `Signet order: ${description}`,
          customer: {
            name: input.customerName,
            email: input.customerEmail || undefined,
            contact: input.customerContact,
          },
          referenceId,
          notes: { agent: 'signet-checkout', sessionId: session.id },
        });

        // Spend is booked against the mandate only after the payment link
        // actually exists, so a failed Razorpay call never burns budget.
        if (session.mode === 'unattended') {
          session.mandateUsage.spentPaise += total;
          session.mandateUsage.transactions += 1;
        }

        session.order = {
          referenceId,
          paymentLinkId: link.id,
          shortUrl: link.short_url,
          status: link.status,
          totalPaise: total,
          items,
          authority,
        };

        result = {
          paymentLinkId: link.id,
          payUrl: link.short_url,
          amount: catalog.formatPrice(total),
          status: link.status,
          authorisedBy: authority.authority,
          mandateRemaining:
            session.mode === 'unattended'
              ? mandate.remaining(session.mandate, session.mandateUsage)
              : undefined,
        };
        break;
      }
      case 'check_payment_status': {
        if (!session.order) {
          result = { error: 'No checkout has been created yet in this session.' };
          break;
        }
        const link = await razorpay.fetchPaymentLink(session.order.paymentLinkId);
        session.order.status = link.status;
        result = { status: link.status, payUrl: link.short_url };
        break;
      }
      default:
        result = { error: 'Unhandled tool.' };
    }

    auditLog.record({
      ...auditBase,
      outcome: 'success',
      result,
      reasoning: input.reasoning,
      authority: result && result.authorisedBy,
    });
    return result;
  } catch (err) {
    const isGuardrail = err instanceof guardrails.GuardrailViolation;
    auditLog.record({
      ...auditBase,
      outcome: isGuardrail ? 'rejected' : 'error',
      code: isGuardrail ? err.code : 'UNEXPECTED_ERROR',
      message: err.message,
    });
    // Graceful failure: return a structured error the agent can explain
    // in plain language, instead of throwing and crashing the turn.
    return { error: err.message, code: isGuardrail ? err.code : 'UNEXPECTED_ERROR' };
  }
}

module.exports = { TOOL_SCHEMAS, executeTool, cartTotalPaise, cartDetail, cartCategories };
