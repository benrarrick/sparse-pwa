# Sparse PWA: notes for Claude

- **Bump `APP_VERSION` (top of `js/app.js`) with every change that is committed.** It is shown small on the home page
  ("Sparse v2.0") so the person testing on a phone can tell which build is running: the offline cache can lag one or two
  launches behind a deploy. Small change or fix: 2.0 → 2.1 → 2.2. Large feature or redesign: 3.0. State the new version in the commit message.
- The AI lab (`#/ai-lab`, `js/ai-lab*.js`) shows a short iPhone list by default; `#/ai-lab?all` shows every experiment.
- Tests: `npm test`. No build step; GitHub Pages serves the repo root.
