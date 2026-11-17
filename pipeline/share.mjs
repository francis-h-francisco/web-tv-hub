// Share pages with rich previews (Open Graph / Twitter cards).
// Social sites don't run JavaScript when building link previews, so each shareable thing gets a small
// static page: one per channel, plus one per show that is on now or coming up next (the shows the app
// lets you share). Show links "expire": once the show has ended the page says so and points to what's on now,
// and after the next 6-hourly refresh the page is gone (404.html then sends visitors to the app).
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const FONT_DIR = new URL('./fonts/', import.meta.url).pathname;
const FONTS = ['Inter-Regular.otf', 'Inter-Bold.otf', 'Inter-ExtraBold.otf'].map((f) => FONT_DIR + f);
const W = 1200, H = 630;

const xml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const html = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slug = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

function wrap(text, maxChars, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) { if (cur) lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  return lines;
}

// trust the file's own signature, not the server's content-type (often wrong)
function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (/<svg[\s>]/i.test(buf.slice(0, 2000).toString())) return 'image/svg+xml';
  return null;
}

async function logoDataUri(url) {
  if (!url) return null;
  try {
    let buf = null;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Mozilla/5.0 (WebTVHub share cards)' } });
      if (r.ok) buf = Buffer.from(await r.arrayBuffer());
    } catch { /* fall through to curl */ }
    // some image hosts (e.g. imgur) refuse Node's HTTP client but serve curl normally
    if (!buf || buf.length < 50 || !/image|svg/.test(sniff(buf) || '')) {
      try { buf = (await run('curl', ['-sfL', '--max-time', '8', '-A', 'Mozilla/5.0 (WebTVHub share cards)', url], { encoding: 'buffer', maxBuffer: 4_000_000 })).stdout; } catch { return null; }
    }
    if (!buf || buf.length > 3_000_000 || buf.length < 50) return null;
    const type = sniff(buf);
    if (!type) return null;
    if (type === 'webp' || type === 'image/gif') { // the card renderer can't read these: convert to PNG first
      return `data:image/png;base64,${(await sharp(buf).png().toBuffer()).toString('base64')}`;
    }
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

function cardSvg(ch, logo, catName) {
  const name = wrap(ch.name, 22, 2);
  const desc = wrap(ch.desc || '', 46, 3);
  const initials = xml(ch.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3));
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#151a26"/><stop offset="1" stop-color="#0b0d12"/></linearGradient>
  <clipPath id="lc"><rect x="70" y="150" width="380" height="250" rx="28"/></clipPath></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="0" y="0" width="${W}" height="10" fill="#ff5a5f"/>
  <rect x="70" y="150" width="380" height="250" rx="28" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.12"/>
  ${logo ? `<image x="100" y="175" width="320" height="200" preserveAspectRatio="xMidYMid meet" xlink:href="${logo}" clip-path="url(#lc)"/>`
    : `<text x="260" y="300" text-anchor="middle" font-family="Inter" font-weight="800" font-size="96" fill="#98a2b3">${initials}</text>`}
  <rect x="510" y="150" rx="22" width="${Math.round(44 + ('● FREE LIVE TV' + (catName ? ' · ' + catName : '')).length * 16.5)}" height="44" fill="#ff5a5f"/>
  <text x="532" y="180" font-family="Inter" font-weight="800" font-size="22" fill="#fff" letter-spacing="2">● FREE LIVE TV${catName ? ' · ' + xml(catName.toUpperCase()) : ''}</text>
  ${name.map((l, i) => `<text x="510" y="${262 + i * 66}" font-family="Inter" font-weight="800" font-size="58" fill="#eef1f6">${xml(l)}</text>`).join('\n  ')}
  ${desc.map((l, i) => `<text x="510" y="${262 + name.length * 66 + 12 + i * 36}" font-family="Inter" font-size="27" fill="#98a2b3">${xml(l)}</text>`).join('\n  ')}
  <circle cx="92" cy="${H - 70}" r="12" fill="#ff5a5f"/>
  <text x="116" y="${H - 60}" font-family="Inter" font-weight="800" font-size="30" fill="#eef1f6">Web TV Hub</text>
  <text x="${W - 70}" y="${H - 60}" text-anchor="end" font-family="Inter" font-size="26" fill="#ffb347">Watch free · no sign-up</text>
</svg>`;
}

function page({ url, img, title, desc, ch, prog, depth, noindex }) {
  const up = '../'.repeat(depth);
  const data = html(JSON.stringify({ ch: ch.id, name: ch.name, s: prog ? prog.s : null, e: prog ? prog.e : null }));
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<meta name="description" content="${html(desc)}">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="canonical" href="${html(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Web TV Hub">
<meta property="og:title" content="${html(title)}"><meta property="og:description" content="${html(desc)}">
<meta property="og:url" content="${html(url)}"><meta property="og:image" content="${html(img)}">
<meta property="og:image:width" content="${W}"><meta property="og:image:height" content="${H}"><meta property="og:image:alt" content="${html(ch.name)} on Web TV Hub">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${html(title)}">
<meta name="twitter:description" content="${html(desc)}"><meta name="twitter:image" content="${html(img)}">
<meta name="theme-color" content="#0b0d12"><link rel="icon" href="${up}icon.svg"><link rel="stylesheet" href="${up}s/share.css">
</head><body data-d="${data}" data-up="${up}"><div class="c"><img src="${html(img)}" alt=""><div class="b">
<span class="p" id="pill">${prog ? 'Show' : 'Live channel'}</span><h1>${html(prog ? prog.t : ch.name)}</h1>
<p class="m" id="when">${html(prog ? 'On ' + ch.name : ch.desc || '')}</p>${prog && prog.d ? `<p class="m">${html(prog.d)}</p>` : ''}
<a class="btn pri" id="go" href="${up}?ch=${encodeURIComponent(ch.id)}">▶ Watch ${html(ch.name)} free</a><a class="btn" href="${up}">See everything that's on now</a>
</div></div><script src="${up}s/share.js"></script></body></html>`;
}

const SHARE_CSS = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#eef1f6;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.c{max-width:34rem;margin:1.2rem;background:#131720;border:1px solid #262e3f;border-radius:1rem;overflow:hidden}.c img{width:100%;display:block}
.b{padding:1.2rem 1.4rem 1.5rem}.p{display:inline-block;font-size:.75rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;padding:.25rem .65rem;border-radius:999px;background:#1b2130;color:#98a2b3}
.p.live{background:#ff5a5f;color:#fff}.p.next{background:#173452;color:#cfe6ff}h1{font-size:1.45rem;margin:.6rem 0 .2rem}.m{color:#98a2b3;margin:.2rem 0 .8rem;line-height:1.5}
a.btn{display:block;text-align:center;text-decoration:none;font-weight:700;padding:.95rem;border-radius:.7rem;margin-top:.6rem;background:#1b2130;color:#eef1f6;border:1px solid #262e3f}a.btn.pri{background:#ffb347;color:#1a1206;border-color:#ffb347}`;

const SHARE_JS = `(function(){var b=document.body,D=JSON.parse(b.getAttribute('data-d')),up=b.getAttribute('data-up'),now=Date.now();
var t=function(ms){return new Date(ms).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})},d=function(ms){return new Date(ms).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})};
var pill=document.getElementById('pill'),when=document.getElementById('when'),go=document.getElementById('go');
if(D.s==null)return;
if(now>=D.e){pill.textContent='This show has ended';when.textContent='It aired on '+D.name+' '+d(D.s)+', '+t(D.s)+'.';go.textContent='\u25B6 See what is on '+D.name+' now';}
else if(now>=D.s){pill.textContent='\u25CF Live now';pill.className='p live';when.textContent='On '+D.name+' until '+t(D.e);}
else{pill.textContent='Coming up \u00B7 '+d(D.s)+', '+t(D.s);pill.className='p next';when.textContent='On '+D.name+' \u00B7 starts in '+Math.max(1,Math.round((D.s-now)/60000))+' min';
go.textContent='\uD83D\uDD14 Remind me \u00B7 watch on '+D.name;go.href=up+'?ch='+encodeURIComponent(D.ch)+'&remind='+D.s;}})();`;

export { SHARE_JS };

export async function buildShare(channels, epg, categories, { outDir, siteUrl, windowHours = 9 }, log) {
  const sdir = `${outDir}/s`;
  await mkdir(`${sdir}/img`, { recursive: true });
  await writeFile(`${sdir}/share.css`, SHARE_CSS);
  await writeFile(`${sdir}/share.js`, SHARE_JS);
  const fontBuffers = await Promise.all(FONTS.map((f) => readFile(f)));
  const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const now = Date.now();
  let cards = 0, shows = 0, logos = 0;
  let i = 0;
  const work = channels.slice();
  const worker = async () => {
    while (i < work.length) {
      const ch = work[i++];
      const id = slug(ch.id);
      const logo = await logoDataUri(ch.logo);
      if (logo) logos++;
      try {
        const png = new Resvg(cardSvg(ch, logo, catName[ch.category]), { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: W } }).render().asPng();
        await writeFile(`${sdir}/img/${id}.jpg`, await sharp(png).jpeg({ quality: 80, mozjpeg: true }).toBuffer()); cards++;
      } catch (e) {
        // a broken logo shouldn't cost the channel its card
        const png = new Resvg(cardSvg(ch, null, catName[ch.category]), { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
        await writeFile(`${sdir}/img/${id}.jpg`, await sharp(png).jpeg({ quality: 80, mozjpeg: true }).toBuffer()); cards++;
      }
      const img = `${siteUrl}s/img/${id}.jpg`;
      await writeFile(`${sdir}/${id}.html`, page({
        url: `${siteUrl}s/${id}.html`, img, depth: 1, ch,
        title: `${ch.name} — watch free on Web TV Hub`, desc: (ch.desc || 'Free live TV channel.') + ' Free, no sign-up.',
      }));
      // every show that's on now or starts before the next refresh (+ a margin), so the app's
      // Now / Up next / Later share buttons always have a page to point to
      const list = epg[ch.id] || [];
      const pick = list.filter((p) => p.e > now && p.s < now + windowHours * 3600e3);
      if (pick.length) await mkdir(`${sdir}/${id}`, { recursive: true });
      for (const p of pick) {
        const name = Math.round(p.s / 60000);
        const extra = [p.ep, p.st].filter(Boolean).join(' · ');
        await writeFile(`${sdir}/${id}/${name}.html`, page({
          url: `${siteUrl}s/${id}/${name}.html`, img, depth: 2, ch, prog: p, noindex: true,
          title: `${p.t}${extra ? ' — ' + extra : ''} · on ${ch.name}`,
          desc: (p.d ? p.d.slice(0, 180) + (p.d.length > 180 ? '…' : '') + ' ' : '') + `Watch free on Web TV Hub.`,
        }));
        shows++;
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  log(`share: ${cards} channel cards (${logos} with logos), ${shows} show pages`);
}
