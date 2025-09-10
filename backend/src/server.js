'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const llm = require('./agent/llm');
const chatRouter = require('./routes/chat');
const auditRouter = require('./routes/audit');
const webhookRouter = require('./routes/webhook');
const agenticRouter = require('./routes/agentic');

const app = express();

app.use(cors());

// The webhook route needs the EXACT raw bytes Razorpay signed, so it gets its
// own raw parser scoped to that one path, mounted before the global json()
// parser. Scoping matters: mounting express.raw() on all of '/api' would make
// req.body a Buffer for /api/chat too, and body-parser's own `req._body` guard
// would then make express.json() skip it silently — every chat request would
// 400 with "sessionId is required". Regression test: test/server.test.js.
app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json' }));
app.use('/api', webhookRouter);

app.use(express.json());
app.use('/api', chatRouter);
app.use('/api', auditRouter);
app.use('/api', agenticRouter);

// Health + config status. The UI calls this on load so a missing API key shows
// up as an explicit banner instead of a confusing failure mid-conversation.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'signet-checkout-backend',
    mode: 'test',
    model: llm.getModel(),
    llm: llm.describe(),
    config: {
      llm: llm.isConfigured(),
      razorpay: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      webhook: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
    },
    guardrails: {
      maxOrderValueInr: Number(process.env.MAX_ORDER_VALUE_INR) || 50000,
      maxItemQuantity: Number(process.env.MAX_ITEM_QUANTITY) || 10,
    },
    // Categories a mandate can be scoped to, so the UI doesn't hardcode them.
    categories: [...new Set(require('./catalog').listAll().map((p) => p.category))].sort(),
  });
});

// Serve the static frontend so the whole demo runs from one port.
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

const PORT = process.env.PORT || 4000;

function describeConfig() {
  const missing = [];
  if (!llm.isConfigured() && llm.providerConfig().keyEnv) missing.push(llm.providerConfig().keyEnv);
  if (!process.env.RAZORPAY_KEY_ID) missing.push('RAZORPAY_KEY_ID');
  if (!process.env.RAZORPAY_KEY_SECRET) missing.push('RAZORPAY_KEY_SECRET');
  return missing;
}

// Only bind a port when run directly, so tests can require() the app and
// drive it over an ephemeral port without fighting over 4000.
if (require.main === module) {
  app.listen(PORT, () => {
    const missing = describeConfig();
    console.log('');
    console.log('  Signet — conversational checkout agent  (Razorpay TEST mode)');
    console.log(`  → http://localhost:${PORT}`);
    const provider = llm.describe();
    console.log(`  model: ${provider.model}  (${provider.label}${provider.free ? ', free tier' : ''})`);
    console.log(
      `  guardrails: max ₹${Number(process.env.MAX_ORDER_VALUE_INR) || 50000}/order, ` +
        `max ${Number(process.env.MAX_ITEM_QUANTITY) || 10}/item`
    );
    if (missing.length) {
      console.log('');
      console.warn(`  ⚠  Missing in backend/.env: ${missing.join(', ')}`);
      console.warn('     Copy backend/.env.example to backend/.env — see docs/SETUP.md.');
      console.warn('     The UI will show a setup banner until these are set.');
    }
    console.log('');
  });
}

module.exports = app;
