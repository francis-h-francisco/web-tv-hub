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

- **`pipeline/`**: Node 22, no dependencies. Every 6 hours it:
  1. fetches iptv-org data and applies `config/curation.json` (blocklist, 6 categories, news caps, source policy, HTTPS only, languages);
  2. health-checks every stream by fetching its playlist, variant playlist and a real video segment, and records whether the web player can read each step (CORS);
  3. merges schedules from public Pluto TV, Samsung TV Plus, Plex and Roku listings, by stream ID or exact channel name, and only when the listing covers the current time;
  4. adds official channel descriptions where the platform publishes them, and otherwise writes a factual one from the schedule ("Comedy and sitcom channel. Shows like Frasier, Wings and Becker.");
  5. looks up cast lists on Wikidata for shows and movies on the schedule, matched by type, year and how well-known each work is, and caches results for 30 days;
  6. writes `site/data/channels.json`, `site/data/epg/<language>.json`, `people.json` and `report.json`.
- **`site/`**: the app, with no build step.
  - **Layout:** on TV and desktop, the player and a Previous / Now playing / Up next / Later timeline sit on the left, and the category guide with now and next for every channel on the right. Phones get a sticky player, a calm list and a bottom tab bar.
  - **Availability is checked on the viewer's device too.** The app quietly probes channels from the viewer's own network and removes any that fail, for example because of region locks. A channel that fails to play is removed from every list immediately.
  - **Profile:** languages (English by default), favorite shows, movies and stars with typo-tolerant autosuggest ("fraiser" finds Frasier), kinds of TV, topics and era. **My TV** lists when your picks are on, plus reminders and favorites.
  - **App features:** installable as an app with an offline shell, and a QR code to open the site on another screen. Captions are off because most channels don't provide reliable ones.
  - **Privacy:** profile, favorites, reminders and the personal playlist are stored in `localStorage` only.
- **Location-aware:** channels not offered in the viewer's country are hidden, based on platform country lists, region-lock labels and local news. See playbook 8c.
- **Phone remote:** Remote on the TV shows a QR code and code; the phone becomes a remote over a direct WebRTC link (`site/remote.js`, PeerJS).
- **Sharing:** every channel, and every show on now or starting within about 9 hours, has a page with a 1200×630 preview card (`site/s/`, built by `pipeline/share.mjs` with resvg and sharp). Show links "expire": after the show ends the page says so and points to what's on now, and after the next refresh it's removed (`404.html` sends visitors to the channel).
- **Cloudflare Pages:** each refresh also publishes the built site, `cloudflare/functions` (API) and `cloudflare/wrangler.toml` to the `cf-pages` branch. A Pages project connected to that branch deploys it (planned address: webtv.pages.dev). The API stores anonymous "plays / doesn't play" reports per country in D1 (`webtv-db`) and serves `/api/unavailable`, so channels that fail for viewers in a country get hidden for everyone there.
- **Viewer features:** pause (back to live) and mute, Chromecast (streams that allow casting), picture-in-picture, sleep timer, continue watching, kids mode with a parent PIN.
- **`app/`**: Android app (Capacitor shell with native reminders). Built, ClamAV-scanned and released by `.github/workflows/android.yml`; download page `site/download.html`.
- **`config/curation.json`**: everything a curator changes, including stream hosts, news channels, categories, languages, guide sources and "where to watch" links.

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
