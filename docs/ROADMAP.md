# Roadmap: future features

Features that are designed or partly built but switched off, with what's needed to turn them on.

## Email reminders and opt-in offers (parked 2026-11-17)

**Status:** code is in the repo and tested, but switched off everywhere. The app shows no email options, every
`/api/email/*` route answers 404, and the Privacy page no longer mentions email. Parked because the owner
doesn't want to use a personal address as the sender yet.

**What's already built**
- Double opt-in sign-up from a reminder or My TV (`site/app.js`, section "email reminders", gated by `EMAIL_ON`).
- Separate, unticked checkbox for offers from Web TV Hub, Norvicka Studio and Pivory Systems; consent wording
  and version stored per subscriber; one-click "stop offers" and "unsubscribe from everything" links.
- Cloudflare Pages Functions in `cloudflare/functions/api/email/` with D1 tables `subscribers`, `email_reminders`, `config`.
- Sender: Google Apps Script (`email-sender/Code.gs`) polling `/api/email/due` every 10 minutes and sending through
  Gmail. It proves who it is with a Google access token; the server only accepts the address stored in D1
  `config.sender_email`, and pins the script's Google client on first use. No shared secret.

**To turn it on**
1. Pick a sender address that's safe to show (a new Gmail like webtvhub.alerts@gmail.com, or a domain address later).
2. Store it: `INSERT INTO config (k, v) VALUES ('sender_email', '<address>')` in D1 `webtv-db`.
3. Cloudflare → webtv-hub → Settings → Variables → add `EMAIL_ENABLED` = `1` (Production), then redeploy.
4. Set `EMAIL_ON = true` in `site/app.js`.
5. Restore the email section of `site/privacy.html` (see git history before 2026-11-17 "park email") and bump its date.
6. Signed in as the sender, paste `email-sender/Code.gs` into a new project at script.google.com and run `setup` once.

**Later options:** a custom domain sender (Cloudflare Email Routing + a transactional provider), and a weekly
"what's on" digest for subscribers who asked for it.
