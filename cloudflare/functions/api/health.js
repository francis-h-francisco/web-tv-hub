import { json } from './_shared.js';
export const onRequestGet = ({ request, env }) => json({ ok: true, db: !!env.DB, country: (request.cf && request.cf.country) || null }, request);
