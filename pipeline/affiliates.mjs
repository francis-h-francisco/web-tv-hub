// "Where to watch" links with the owner's affiliate IDs applied.
// Reads config/affiliates.json, checks it, and returns what the app needs: for each service, a link
// template where {q} is the viewer's search, already carrying the affiliate tracking when an ID is set.
// Services whose ID is still empty keep a plain link, so a half-finished setup never breaks anything.

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export function fillIds(text, ids) {
  let missing = false;
  const out = String(text).replace(PLACEHOLDER, (_, k) => {
    const v = ids[k];
    if (v == null || String(v).trim() === '') { missing = true; return ''; }
    return String(v).trim();
  });
  return missing ? null : out;
}

/** Throw a readable error for anything that would produce a broken or unsafe link. */
export function validateAffiliates(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') throw new Error('affiliates.json: not a JSON object');
  if (typeof cfg.myIds !== 'object' || !cfg.myIds) errs.push('myIds must be an object');
  if (!Array.isArray(cfg.services)) errs.push('services must be a list');
  const ids = new Set();
  for (const [i, s] of (cfg.services || []).entries()) {
    const at = `services[${i}]${s && s.id ? ' (' + s.id + ')' : ''}`;
    if (!s || typeof s !== 'object') { errs.push(at + ': not an object'); continue; }
    if (!s.id || !/^[a-z0-9-]+$/.test(s.id)) errs.push(at + ': id must be lowercase letters, numbers or dashes');
    if (ids.has(s.id)) errs.push(at + ': duplicate id'); ids.add(s.id);
    if (!s.name) errs.push(at + ': name is missing');
    if (!/^https:\/\//.test(s.url || '')) errs.push(at + ': url must start with https://');
    if (!Array.isArray(s.countries) || !s.countries.length || !s.countries.every((c) => c === '*' || /^[A-Z]{2}$/.test(c))) errs.push(at + ': countries must be like ["*"] or ["US", "GB"]');
    if (!Array.isArray(s.keywords)) errs.push(at + ': keywords must be a list');
    const a = s.affiliate;
    if (a != null) {
      if (a.add != null && (typeof a.add !== 'object' || Array.isArray(a.add))) errs.push(at + ': affiliate.add must be like { "tag": "{{amazonTag}}" }');
      if (a.wrap != null && typeof a.wrap !== 'string') errs.push(at + ': affiliate.wrap must be text');
      for (const t of [a.wrap || '', ...Object.values(a.add || {})]) for (const m of String(t).matchAll(PLACEHOLDER)) if (!(m[1] in (cfg.myIds || {}))) errs.push(at + `: {{${m[1]}}} is not in myIds`);
    }
  }
  for (const [k, v] of Object.entries(cfg.myIds || {})) {
    const s = String(v || '').trim();
    if (!s) continue;
    if (/\s/.test(s)) errs.push(`myIds.${k}: contains spaces`);
    // a tracking link pasted as an ID must be a real https link with {url}, or a plain ID
    if (/^https?:/.test(s) && !/^https:\/\//.test(s)) errs.push(`myIds.${k}: tracking links must start with https://`);
  }
  if (errs.length) throw new Error('affiliates.json has problems:\n - ' + errs.join('\n - '));
}

/** The services as the app uses them: { id, name, url (with {q}), wrap (tracking link with {url}) , aff, countries, keywords, suggest } */
export function resolveAffiliates(cfg) {
  validateAffiliates(cfg);
  const ids = cfg.myIds || {};
  const out = [];
  for (const s of cfg.services) {
    if (s.enabled === false) continue;
    let url = s.url, wrap = null, aff = false;
    const a = s.affiliate;
    if (a && a.add) {
      const add = {}; let ok = true;
      for (const [k, v] of Object.entries(a.add)) {
        const f = fillIds(v, ids);
        if (f === null) ok = false; else add[k] = f;
      }
      if (ok && Object.keys(add).length) {
        const [base, hash] = url.split('#');
        const qs = Object.entries(add).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
        url = base + (base.includes('?') ? '&' : '?') + qs + (hash ? '#' + hash : '');
        aff = true;
      }
    }
    if (a && a.wrap) {
      const w = fillIds(a.wrap, ids);
      // the app puts the (encoded) destination where {url} is; a tracking link without {url} is used as-is
      if (w) { wrap = w; aff = true; }
    }
    out.push({ id: s.id, name: s.name, url, wrap, aff, countries: s.countries, keywords: s.keywords || [], suggest: !!s.suggest });
  }
  return { disclosure: cfg.disclosure || '', services: out };
}
