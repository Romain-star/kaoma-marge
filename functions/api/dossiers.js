// KAOMA Marge — API base partagée (Cloudflare Pages Function)
// Route : /api/dossiers
// Stockage : KV namespace bindé sous le nom DOSSIERS
//
// GET    /api/dossiers          -> liste tous les dossiers (JSON array)
// POST   /api/dossiers          -> enregistre/met à jour un dossier (body JSON, doit contenir .id)
// DELETE /api/dossiers?id=xxx   -> supprime un dossier
//
// Chaque dossier est stocké sous la clé KV "dossier:<id>".

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export async function onRequestGet({ env }) {
  if (!env.DOSSIERS) return json([], 200); // pas de KV bindé -> liste vide (le front bascule en local)
  const list = await env.DOSSIERS.list({ prefix: 'dossier:' });
  const items = await Promise.all(
    list.keys.map(async (k) => {
      const v = await env.DOSSIERS.get(k.name);
      try { return JSON.parse(v); } catch { return null; }
    })
  );
  return json(items.filter(Boolean));
}

export async function onRequestPost({ request, env }) {
  if (!env.DOSSIERS) return json({ error: 'KV non configuré' }, 503);
  let d;
  try { d = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400); }
  if (!d || !d.id) return json({ error: 'id manquant' }, 400);
  d.updated = new Date().toISOString();
  await env.DOSSIERS.put('dossier:' + d.id, JSON.stringify(d));
  return json({ ok: true, id: d.id });
}

export async function onRequestDelete({ request, env }) {
  if (!env.DOSSIERS) return json({ error: 'KV non configuré' }, 503);
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: 'id manquant' }, 400);
  await env.DOSSIERS.delete('dossier:' + id);
  return json({ ok: true });
}
