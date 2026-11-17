# Project Agent Preflight — web-tv-hub

## Purpose and authority
Project-specific pre-task instructions. Follow root AGENTS.md and the shared Agent Protocol; explicit owner instructions and security constraints take precedence.

## Project identity and scope
- Repository: `francis-h-francisco/web-tv-hub` (public; `main` auto-deploys to GitHub Pages).
- Product: free, curated, TV-remote-friendly live TV web app built on iptv-org data. Governing spec: `docs/PLAYBOOK.md` (v2).
- In scope now (v1.x): curation rules, pipeline reliability, EPG coverage, TV-browser UX, accessibility, Cloudflare Pages mirror, QR launch, PWA.
- Out of scope without owner approval: paid tiers and payments, affiliate tags, accounts or server-side personal data, Worker + D1 backend, any new stream source category.

## Before acting
- Verify branch, latest commit, open PRs and the last "Refresh channels and deploy" workflow run.
- Read `site/data/report.json` from the last run (or run `npm run build:data`) before changing curation.
- Check the change against the source policy and legal notes in `docs/PLAYBOOK.md` sections 4–5.

## During and after work
- Branch + draft PR. Run `npm test`. For UI changes, test with keyboard arrows/Enter/Esc only (no mouse) at 1920×1080 and at phone width.
- Report counts before and after for any curation change (channels per category, EPG coverage).

## Safety and approval
- No secrets in the repo. The pipeline needs none.
- Do not add streams from denied hosts, HTTP streams, or streams needing custom headers.
- Owner approval is required before merging to `main` (production deploy), changing `sourcePolicy`, or adding monetization.

## Project-specific configuration
- Site origin used for CORS checks: `config/curation.json` → `siteOrigin`. Update it if the site moves to Cloudflare Pages or a custom domain.
- GitHub scheduled workflows pause after 60 days without repo activity; re-enable from the Actions tab if refreshes stop.
