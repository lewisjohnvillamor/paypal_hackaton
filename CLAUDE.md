# Refund Relay

## Front-end design

Any change to a page in `public/` follows the brand system in `hackathon/DESIGN.md` and the taste skill vendored at `.claude/skills/taste-skill` (tasteskill v2, MIT). Merchant screens (`public/merchant/`, `public/dashboard.html`) are app screens: read `.claude/skills/taste-skill/references/app-screens.md`. The store and buyer pages (`index.html`, `claim.html`, `status.html`) follow the page rules in its `SKILL.md`.

- Use the tokens at the top of `public/app.css`; no new colours, fonts, gradients, shadows on resting cards, or eyebrow labels above titles.
- Marker yellow (`--mark`) is the brand: the logo, the damage box, one highlighted figure. Never a text colour.
- Keep the PayPal button on PayPal's own styles, and keep AG Grid Community on the requests and remedies screens.

## Checks

`npm test` (153 tests). Live flows: `scripts/e2e-agent.js` and `scripts/e2e-sandbox.js` against `npm start` with the sandbox `.env`.
