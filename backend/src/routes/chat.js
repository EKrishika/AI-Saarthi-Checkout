'use strict';

const express = require('express');
const sessionStore = require('../agent/sessionStore');
const { cartDetail, cartTotalPaise } = require('../agent/tools');
const { handleUserMessage } = require('../agent/agent');

const router = express.Router();

router.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId (string) is required.' });
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message (string) is required.' });
  }

  const session = sessionStore.getOrCreate(sessionId);

  try {
    const result = await handleUserMessage(session, message);
    res.json(result);
  } catch (err) {
    // Last-resort graceful failure so a bug never surfaces as a raw 500
    // with a stack trace to the buyer.
    console.error('Unhandled error in /api/chat:', err);
    res.status(200).json({
      reply:
        "Something went wrong on my end handling that. Nothing was charged. Could you try rephrasing, or say 'view cart' to see where things stand?",
      cart: cartDetail(session.cart),
      cartTotalPaise: cartTotalPaise(session.cart),
      order: session.order,
      toolCalls: [],
    });
  }
});

module.exports = router;
