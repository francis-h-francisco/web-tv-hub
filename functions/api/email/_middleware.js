// Email feature is parked (see docs/ROADMAP.md). Every /api/email/* route answers 404 unless the
// Cloudflare environment variable EMAIL_ENABLED is set to "1".
export async function onRequest(context) {
  if (context.env.EMAIL_ENABLED !== '1') {
    return new Response(JSON.stringify({ error: 'not_available' }), { status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
  return context.next();
}
