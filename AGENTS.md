# Agent instructions — web-tv-hub

Universal Agent Protocol commands are loaded by `#init` from `francis-h-francisco/agent-protocols`; they are not duplicated here.

Before project work, read `.agent/PROJECT_PREFLIGHT.md`, then `README.md` and `docs/PLAYBOOK.md`.

- Run `npm test` before proposing pipeline changes; run `npm run build:data` and check `site/data/report.json` counts when changing `config/curation.json`.
- Keep the site dependency-free and build-free (plain HTML/CSS/JS + vendored hls.js) so it runs in old TV browsers.
- Never add streams from hosts in `sourcePolicy.deniedHosts`, never add HTTP streams, and never remove the iptv-org blocklist check.
- Use a branch and draft PR. Do not merge to `main` without owner approval: `main` deploys to production automatically.
