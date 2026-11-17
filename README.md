# Web TV Hub

A free, lean-back web TV site: curated live channels that broadcasters already stream for free, with a TV-remote-friendly interface, a schedule bar (previous show, live now, next two), favorites, reminders and a skippable profile wizard.

**Live site:** https://francis-h-francisco.github.io/web-tv-hub/
**Product playbook:** [docs/PLAYBOOK.md](docs/PLAYBOOK.md)

## How it works

```
GitHub Actions (every 6 h)                         Browser (TV stick, phone, laptop)
  iptv-org API ──► curate ──► health-check ──►      site/  (static: HTML + JS + hls.js)
  XMLTV guides ──────────────► EPG ─────────►        data/channels.json, data/epg.json
                                     deploy to GitHub Pages
```

- **`pipeline/`**: Node 22 script, no dependencies. Fetches iptv-org data, applies the rules in `config/curation.json` (blocklist, 6 categories, news caps, source policy, HTTPS only), then checks each stream's playlist, variant and first video segment, including CORS. It also merges XMLTV guide data and writes `site/data/*.json`, plus `report.json` with counts.
- **`site/`**: the app. There's no build step. Uses arrow-key spatial navigation, Back/Esc handling (including webOS/Tizen key codes), and hls.js with a fallback to the browser's built-in HLS player. It skips dead channels and remembers them for 24 h. Profile, favorites, reminders and the personal playlist are stored in `localStorage` only.
- **`config/curation.json`**: everything a curator changes: allowed and denied stream hosts, news channel choices, category mapping, guide sources and "where to watch" links. Push a change and the next run applies it.

## Run locally

```bash
npm test                 # pipeline unit tests
npm run build:data       # full refresh into site/data (about 30 s)
npm run serve            # http://localhost:8080
```

## Deploy

- **GitHub Pages (current):** `.github/workflows/refresh-and-deploy.yml` runs on every push to `main`, every 6 hours, and on demand from the Actions tab. Pages source must be set to **GitHub Actions** (Settings → Pages).
- **Cloudflare Pages (later):** connect the repo in the Cloudflare dashboard, with build command `node pipeline/build.mjs --out site/data` and output directory `site`. Or keep building in Actions and push `site/` with `wrangler pages deploy site`.

## Content and takedowns

We don't host or re-stream video. Each channel plays directly from its broadcaster or an official free ad-supported service. To remove a channel, add its iptv-org id to `denyChannels` in `config/curation.json` and push. Rights-holders can open an issue titled "Removal request".

## Agents

See [AGENTS.md](AGENTS.md) and [.agent/PROJECT_PREFLIGHT.md](.agent/PROJECT_PREFLIGHT.md).
