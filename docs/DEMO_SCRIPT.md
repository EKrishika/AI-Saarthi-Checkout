# Signet — 5 Minute Video Script

Simple English. Short lines. Read them slowly and clearly.

---

# BEFORE YOU RECORD

**Terminal 1** — start the app, then leave it alone:
```bash
cd backend
rm -f data/audit.jsonl
npm start
```

**Terminal 2** — open a second terminal for later:
```bash
cd backend
```

**Open these windows:**
1. Browser at `http://localhost:4000` — zoom to 125% (`Ctrl` and `+`)
2. Notepad with the log file: `notepad data/audit.jsonl`

**Check:** the top bar says `Groq (free)` and there is **no orange strip**.

**Important:** wait 8 seconds between clicks. Speak while you wait.

---

# THE SCRIPT

---

## 0:00 – 0:20 · Start
**Show: your face, or a title slide**

> "Hi. I am [YOUR NAME].
>
> Today, people go to a website to buy things.
>
> Soon, their AI will do it for them.
>
> This is Signet. It helps a shop take money from an AI, safely.
>
> I built it on Razorpay payment links, in test mode."

---

## 0:20 – 0:50 · The problem
**Show: your face**

> "Many people are building AI that can shop. That part is easy.
>
> Because a human is still there. The human says yes before every payment.
>
> So the human is the safety.
>
> But what if the human is not there? What stops the AI then?
>
> And later, how do we know what it did?
>
> That is the problem I solved."

---

## 0:50 – 1:35 · Tab 1 — the normal way
**Show: the app, "Assisted checkout" tab. Click the buttons. Do not type.**

**Click** `I need wireless earbuds under 5000`

> "I asked in simple words. It found the product. Real price. Real stock."

*Point at the small grey tag above the answer.*

> "This tag shows the tool it used. You can see its work."

**Click** `Add 2 of those` *(wait 8 seconds)*

> "It added two to my cart."

**Click** `Add 500 desk lamps`

> "Now let me try to break it."

*Point at the orange box.*

> "Blocked. The limit is ten per item.
>
> And see — it tried. The block is saved in the log. It did not hide it."

**Click** `Checkout — name Aisha...` *(wait)* then **click** `Yes, go ahead`

> "It must show me the order first. Then I say yes.
>
> Only then it makes a payment link. This is a real Razorpay link."

---

## 1:35 – 3:10 · Tab 2 — the main part
**Show: "Unattended run" tab**

> "Now the main part.
>
> I will give the AI some rules. Then I will walk away."

*Type: budget **8000**, per order **5000**, transactions **2**. Click **audio**.*

> "Total budget: eight thousand rupees.
>
> One order: maximum five thousand.
>
> Only audio products.
>
> Only two purchases.
>
> And it ends in one hour.
>
> These rules are signed. So the AI cannot change them. If it changes even one
> number, the signature breaks."

**Click** `Issue mandate & run unattended`

*Wait. Point at the four tags, then the green box.*

> "It searched. It added. It checked. Then it paid.
>
> I did not say yes. Nobody said yes.
>
> Only the signature allowed it.
>
> Look at the bar. Three thousand four hundred and ninety nine spent. One
> purchase left."

*(Say this too — it answers a question judges will ask)*

> "One more thing. It made a payment link. It did not take money from a card.
>
> So the money still needs a human tap. That is the safe way to start."

**Now change `audio` to `storage`. Click run again.**

> "Same AI. Same job — buy earbuds.
>
> But now the rules say storage only."

*Point at the orange rejection.*

> "Blocked. Category not allowed.
>
> Nobody was here to stop it. Only the rules stopped it.
>
> This is the main point of my project."

---

## 3:10 – 3:45 · The logbook
**Show: Terminal 2**

```bash
npm run audit
```

> "This is the logbook. Every action is here.
>
> Green means nothing was changed."

**Show: Notepad.** Press **Ctrl+H**.
Find `"quantity":1` — Replace with `"quantity":100` — click **Replace** — press **Ctrl+S**.

> "Now I will change the log myself.
>
> I am changing one, to one hundred."

**Show: Terminal 2 again.** Run `npm run audit`

> "Red. Record two was changed.
>
> Anyone can write 'safe' in a readme.
>
> Here, you can check it yourself."

---

## 3:45 – 4:10 · Tab 3 — growth
**Show:** Click **New session** → add something to cart → **do not** check out →
**Recovery** tab → put `0` → click **Scan**

> "Now the growth part.
>
> Some people add items but do not pay.
>
> My app finds them. It writes a message for them. And it makes a ready payment
> link.
>
> So they do not have to start again."

**Click** `Draft nudge & create link`

---

## 4:10 – 4:40 · How it works inside
**Show: `guardrails.js` in your editor, then `npm test` in the terminal**

> "Inside, there is one file called guardrails.
>
> It checks every action. It does not know about the AI. It only sees the
> actions.
>
> So it works even if the AI makes a mistake.
>
> Eighty three tests. All passing.
>
> And it works with any AI — Groq, Gemini, or Claude. Just one setting."

---

## 4:40 – 5:00 · End
**Show: your face**

> "I kept this small on purpose. One shop. One payment method.
>
> Next, I want the rules to be signed by the buyer, not by my server. So the
> same rules work on any shop.
>
> The code is on GitHub. The link is below.
>
> Thank you for watching. I would love to build this at Razorpay."

---

# IF SOMETHING GOES WRONG

| Problem | What to do |
|---|---|
| It says "rate-limited" | Wait 15 seconds. Click again |
| The AI gets confused | Click **New session**. Do that part again |
| Recovery tab is empty | You paid already. New session → add to cart → do not pay |
| `EADDRINUSE` error | The app is already running. Use it, or run `npx kill-port 4000` |
| Notepad won't open the file | Run `notepad data/audit.jsonl` in the terminal |

---

# IF A JUDGE ASKS

**"Does it search real shops?"**
> "No. It uses a product list, like a shop would give to an AI. You can replace
> it with a real shop API. Nothing else changes. Finding products is not the
> hard part. Controlling spending is."

**"What if the buyer does not like it?"**
> "The rules are the buyer's choice, made before. And it only makes a payment
> link. If they do not want it, they do not pay."

**"Is the signature real?"**
> "Yes. It is an HMAC signature made by my server. It proves nobody changed the
> rules. The next step is for the buyer to sign it themselves."

---

# THREE LINES TO REMEMBER

1. *"When a human says yes every time, a spending limit does nothing."*
2. *"I did not say yes. The signature did."*
3. *"Anyone can write 'safe' in a readme. Here you can check it."*
