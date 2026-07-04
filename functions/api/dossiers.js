// KAOMA Marge — API base partagée (Cloudflare Pages Function)
// Route : /api/dossiers
// Stockage : KV namespace bindé sous le nom DOSSIERS
//
// GET    /api/dossiers                 -> liste tous les dossiers (JSON array)
// GET    /api/dossiers?history=<id>    -> historique (snapshots) d'un dossier, du + récent au + ancien
// POST   /api/dossiers                 -> enregistre/met à jour un dossier (body JSON, doit contenir .id)
//        body optionnel: .baseUpdated  -> horodatage de la version chargée (détection de conflit)
//        body optionnel: .force=true   -> force l'écriture même en cas de conflit
// DELETE /api/dossiers?id=xxx          -> supprime un dossier (snapshot conservé avant suppression)
//
// SÉCURITÉ « NE RIEN PERDRE » :
//  - Chaque écriture archive d'abord la version précédente sous "hist:<id>:<horodatage>" (récupérable ~120 j).
//  - Détection de conflit optimiste : si un autre poste a enregistré depuis que le client a chargé
//    le dossier, on renvoie 409 avec la version serveur actuelle (le client peut recharger ou forcer).
//  - La suppression archive aussi la dernière version.
// Chaque dossier courant est stocké sous la clé KV "dossier:<id>".

const HIST_MAX = 40;                 // nb de versions conservées par dossier
const HIST_TTL = 60 * 60 * 24 * 120; // 120 jours

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export async function onRequestGet({ request, env }) {
  if (!env.DOSSIERS) return json([], 200); // pas de KV bindé -> liste vide (le front bascule en local)
  const url = new URL(request.url);
  const histId = url.searchParams.get('history');

  if (histId) {
    const list = await env.DOSSIERS.list({ prefix: 'hist:' + histId + ':' });
    const items = await Promise.all(
      list.keys.map(async (k) => {
        const v = await env.DOSSIERS.get(k.name);
        try { return { _key: k.name, ...JSON.parse(v) }; } catch { return null; }
      })
    );
    // du plus récent au plus ancien
    items.sort((a, b) => String(b && b.updated || '').localeCompare(String(a && a.updated || '')));
    return json(items.filter(Boolean));
  }

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

  const key = 'dossier:' + d.id;
  const baseUpdated = d.baseUpdated;
  const force = d.force === true;
  delete d.baseUpdated;
  delete d.force;

  // Version précédente -> conflit + historique
  let prevRaw = null;
  try { prevRaw = await env.DOSSIERS.get(key); } catch {}
  if (prevRaw) {
    let prev = null;
    try { prev = JSON.parse(prevRaw); } catch {}
    // Conflit optimiste : le serveur a été modifié depuis le chargement du client
    if (prev && !force && baseUpdated && prev.updated && String(prev.updated) > String(baseUpdated)) {
      return json({ conflict: true, current: prev }, 409);
    }
    // Archive de la version précédente (jamais rien perdre) — best-effort
    try {
      const ts = (prev && prev.updated) || new Date().toISOString();
      await env.DOSSIERS.put('hist:' + d.id + ':' + ts, prevRaw, { expirationTtl: HIST_TTL });
      const hl = await env.DOSSIERS.list({ prefix: 'hist:' + d.id + ':' });
      if (hl.keys.length > HIST_MAX) {
        const olders = hl.keys.map((k) => k.name).sort().slice(0, hl.keys.length - HIST_MAX);
        for (const name of olders) { try { await env.DOSSIERS.delete(name); } catch {} }
      }
    } catch {}
  }

  d.updated = new Date().toISOString();
  await env.DOSSIERS.put(key, JSON.stringify(d));
  return json({ ok: true, id: d.id, updated: d.updated });
}

export async function onRequestDelete({ request, env }) {
  if (!env.DOSSIERS) return json({ error: 'KV non configuré' }, 503);
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: 'id manquant' }, 400);
  const key = 'dossier:' + id;
  // Snapshot avant suppression (récupérable)
  try {
    const prevRaw = await env.DOSSIERS.get(key);
    if (prevRaw) await env.DOSSIERS.put('hist:' + id + ':deleted:' + new Date().toISOString(), prevRaw, { expirationTtl: HIST_TTL });
  } catch {}
  await env.DOSSIERS.delete(key);
  return json({ ok: true });
}
