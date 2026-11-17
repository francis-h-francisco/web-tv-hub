// Where each free ad-supported (FAST) channel is officially offered.
// Pluto TV, Samsung TV Plus and Plex publish per-country channel lists; a channel reached through
// one of them only plays in those countries. The app hides it everywhere else, so nobody sees a
// channel that can't play where they are.

const SOURCES = [
  { prefix: 'plu', url: 'https://i.mjh.nz/PlutoTV/.channels.json' },
  { prefix: 'stvp', url: 'https://i.mjh.nz/SamsungTVPlus/.channels.json' },
  { prefix: 'plex', url: 'https://i.mjh.nz/Plex/.channels.json' },
];
const RE = /^https:\/\/jmp2\.uk\/([a-z]+)-([A-Za-z0-9]+)/;
const iso = (r) => (r.toLowerCase() === 'gb' ? 'GB' : r.toUpperCase());

export async function loadRegions(log) {
  const map = new Map(); // "plu:<id>" -> Set(ISO2)
  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const add = (id, region) => {
        const k = src.prefix + ':' + id;
        if (!map.has(k)) map.set(k, new Set());
        map.get(k).add(iso(region));
      };
      if (d.regions) for (const [reg, v] of Object.entries(d.regions)) for (const id of Object.keys(v.channels || {})) add(id, reg);
      if (d.channels) for (const [id, c] of Object.entries(d.channels)) for (const reg of c.regions || []) add(id, reg);
    } catch (e) {
      log(`regions ${src.prefix} failed: ${e.message}`);
    }
  }
  return map;
}

/** ISO2 countries where the channel's best stream is offered, or null when unknown. */
export function channelRegions(channel, map) {
  for (const s of channel.streams) {
    const m = RE.exec(s.url);
    if (!m) continue;
    const set = map.get(m[1] + ':' + m[2]);
    if (set) return [...set].sort();
  }
  return null;
}
