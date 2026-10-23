---
name: guided-demo
description: Build or improve a self-guided product demo inside a web app (a demo site with sample data and an in-app walkthrough / virtual tour) that a client's leadership or board opens alone, with no presenter. Use when asked to make a demo, a walkthrough, a guided tour, a "demo for the board", or when an existing tour feels thin, confusing or skips part of the business process.
---

# guided-demo

A good demo tells **one true story of the client's process**, on **real screens**, with **sample data that can't be
mistaken for their numbers**, and lets the visitor **always see where they are**. The visitor watches alone: every
screen has to explain itself, and nothing on it may need a presenter's "ignore that".

`tour-pattern.md` (next to this file) has the tour mechanics, the step format and the review checklist.

## 0. Before building

- **Who opens it and what they decide after.** Leadership deciding on a pilot needs the whole chain and the next step;
  users being trained need depth on their own screens. Write it down in one line.
- **Done when:** "<person> walks the tour on <device> and sees <the chain> including <the part they care about>".
- **Non-goals:** no new product features for the demo, no forecasts, savings calculators, capacity planning or
  dashboards of made-up money. Building a screen only for the demo is a warning sign: show what the product does.
- If a demo exists, **review it first in a real browser**: walk every step, screenshot each, and list what is wrong
  before proposing anything (see the review checklist in `tour-pattern.md`).

## 1. The story

1. **One sentence, one object carried through.** "One <document> from <first step> to <last step>." Pick the object the
   client's business actually passes along (a plan, a quote, a case, a shipment) and follow the same instance
   (same customer, same unit, same order number) from start to end.
2. **Stages = the client's real process, in their order.** List them as the business runs them, not as the app's
   menu is arranged. A typical chain: sell / quote → order → work order / fulfilment → **field work** → report →
   review → fix / learn → next step. Ask "who touches it next?" until the chain closes.
3. **Every stage names who does it** (sales rep, customer, office, field crew, lead). Roles are what makes leadership
   recognise their company.
4. **Don't skip the people away from a desk.** The field crew, driver or technician is usually the stage that's
   missing, and the one that convinces. Show their screen on a phone, because that's where they work.
5. **Show the moment of creation,** not only the result: the request as it was filled in, then what it turned into
   (one request → two orders with their numbers). Before / after beats a finished record.
6. **End on the next decision:** what can be tried here, the next supervised step, what's needed from the client's IT.
   No price or timeline unless the owner approved them.

Write the plan as a table and get the owner's go before building:

| Stage | Who | What the screen shows | New / existing |
| --- | --- | --- | --- |

## 2. The data

- **One coherent sample dataset and timeline.** The same people, properties and order numbers across every screen;
  dates in order (an order is created before its install, a report after it). A sample that contradicts itself reads
  as a bug.
- **Clearly sample:** made-up people, a "Sample data" line on every page, simulated integrations named as simulated.
  Say it once at the start of the tour, not on every step.
- **No numbers that read as the client's results:** no revenue, savings, accuracy % or rankings computed from sample
  data.
- **One thing the visitor can do themselves** (a prepared record to take through the first stage), and a nightly
  reset so one visitor doesn't spoil it for the next.
- Seed it with a script in the repo, so the demo can be rebuilt from scratch.

## 3. The tour

Follow `tour-pattern.md`. The essentials:

- **About 15 steps, about 5 minutes.** First step: the map of stages. Last step: the next decision.
- **A progress strip of the stages** (done ✓ / current / ahead, clickable) plus "Step n of N" and a fill bar.
- **The panel never covers what it points at:** dock it at the bottom (a bottom sheet on phones), light up the target
  and scroll it into the space above the panel.
- **1–2 sentences per step.** The title says what happens ("The crew reports the material"), the text says why it
  matters, with the concrete sample fact ("3 SY short in the bedroom closet").
- **Real screens only.** For a mobile screen, embed the real page in a phone frame (drawn at 375 px, scaled), in a
  preview mode where sending is off.
- **The tour never writes.** Show saved records through read-only views (URL parameters that open a saved request),
  never by clicking the app's own buttons. Guard writes in the API client while the tour runs, and test it.

## 4. Build and verify

- Work in a separate branch / worktree; show the owner locally before deploying.
- Walk the whole tour in a real browser at a short laptop screen (about 1440×700) and at phone width (about 390):
  screenshot every step and check the lit target is visible, not covered, and the text matches what's on screen.
- Tests: every stage appears in order; every step lights something up or shows a phone; copy has no vendor or model
  names and follows the house style; the tour cannot write; any preview route is signed-in only and sends nothing.
- Run the app's existing checks (type check, unit tests, browser scenarios) before deploying.
- Deploy only on the owner's go. After it, check the live revision and that new routes refuse signed-out visitors.
- Report: what changed, how it was checked, the limits (for example sample dates that still look odd), and what wasn't
  checked.
