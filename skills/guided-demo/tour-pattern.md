# The tour pattern

An in-app walkthrough for a web app with a hash or path router. Framework-free; about 300 lines of TypeScript plus CSS.

## Step format

```ts
const STAGES = ["Quote", "Order", "Work order", "Field", "Review", "Fix", "Next"] as const;
interface TourStep {
  stage: typeof STAGES[number] | "Start"; // "Start" = the introduction, before the first stage
  role?: string;      // who does this: "Sales rep", "Customer", "Office", "Field crew", "Lead"
  title: string;      // what happens, 3-6 words
  text: string;       // 1-2 sentences: why it matters + the concrete sample fact
  route: string;      // "#/order/{customer}?request={submission}": ids filled in at start
  selector?: string;  // what to light up on that page
  phone?: string;     // a page shown in a phone frame instead ("/api/orders/{order}/field-preview")
}
```

- **Ids by identity.** At start, load the sample records and find the story's instances by name / number. A missing
  record sends the step to a safe fallback page with "This example is not available"; never substitute another record.
- One route template may hold several ids; fill all or fall back.

## The panel

- A native `<dialog>` opened with `showModal()`: the page behind is inert, focus stays in the tour.
- Docked at the bottom, full width up to about 1080 px; on phones a bottom sheet (max about 60% of the height).
- Top to bottom: a thin bar that fills with each step; the stage strip (numbered dots joined by a line: done = filled
  with ✓, current = accent color, ahead = outlined; each dot jumps to the stage's first step; on phones numbers only
  plus the current stage's name); then the role chip, "Step n of N", the title, the text; buttons Skip tour · Back ·
  Next (Next is the accent, last step says Finish).
- Keys: → next, ← back, Esc closes, Tab cycles the panel's buttons. Arrow keys are captured before the app's own
  shortcuts.
- Progress saved in localStorage with a version number (`{version, index}`); "Resume tour" in the menu; a stale or
  corrupt value is ignored.
- An invitation ("New here? Take a 5-minute tour") once per browser, dismissable.

## Lighting the target

- A spotlight box around the target with `box-shadow: 0 0 0 100vmax <shade>`; a full shade when there's no target.
- Keep targets clear of the panel: set `--tour-panel` to the panel's height, use
  `html { scroll-padding-bottom: var(--tour-panel) }` while the tour runs, and add that much empty space after the
  page (`body::after`) so the end of a page can scroll above the panel.
- Tall targets scroll to their top; others to the centre of the free space. Re-place the spotlight on scroll, resize
  and when the target or panel changes size (ResizeObserver).
- Wait for the route to render (poll for the selector up to about 5 s); a later step must cancel an earlier wait.

## The phone

- A frame (dark rounded body, notch) standing full height on the right on wide screens, with the panel beside it;
  above the panel on narrow ones.
- The real page in an `<iframe sandbox="allow-scripts">`, drawn at 375 px wide and scaled with `transform: scale()`
  to the frame. Position it absolutely inside the frame so its width never stretches the frame.
- A server preview route for it: signed in only, the demo edition only, the same page code with sending disabled,
  CSP `connect-src 'none'; form-action 'none'; frame-ancestors 'self'`, and `?report=1` (or similar) to fill in the
  saved example and scroll to the part that matters. Tested: refused signed out, refused outside the demo edition.

## Read-only

- While the tour runs, the API client throws on every write (POST / PUT / DELETE / uploads / link creation) before it
  reaches the network; reopen pages normally after the tour so editing comes back.
- Saved records are shown through read-only URL parameters (`?request=<id>` fills the order screen as it was ordered,
  `&placed=1` shows its confirmation), handled only in the demo edition.

## Review checklist (an existing tour, or yours before showing it)

- [ ] Can the visitor tell where they are in the process at every step, and how much is left?
- [ ] Does any step's panel cover what it points at? (short laptop screen, about 1440×700)
- [ ] Does the chain close: sell → order → fulfil → field → report → review → fix → next? Which stage is missing?
- [ ] Is the field / mobile person's own screen shown?
- [ ] Is the moment of creation shown (input → what it became), or only finished records?
- [ ] Is each step's actor named?
- [ ] Is each text 1-2 sentences, with disclaimers said once and not on every step?
- [ ] Is the sample consistent: same instance throughout, dates in order, nothing reading as real results?
- [ ] Does the last step say what to do next?
- [ ] Phone width: is the strip readable and the panel not taller than the screen?
- [ ] Can the tour write anything? Can a new preview route be opened signed out?
