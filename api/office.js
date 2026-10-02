import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const EMAIL_DOMAIN = 'csp-asso.local';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans caractères ambigus
const genCode = (len = 8) => Array.from({ length: len }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const emailOf = (m) => `${m.toLowerCase()}@${EMAIL_DOMAIN}`;
const clean = (s, max = 80) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

async function classeParNom(nom) {
  const { data } = await db.from('classes').select('code, nom').eq('nom', nom).maybeSingle();
  if (!data) throw new Error('Classe inconnue');
  return data;
}

async function enregistrerEleves({ classe, eleves }) {
  const cl = await classeParNom(classe);
  if (!Array.isArray(eleves) || !eleves.length) throw new Error('Aucun élève à enregistrer');
  const erreurs = [];
  const valides = [];
  const vus = new Set();
  for (const e of eleves) {
    const matricule = String(e.matricule ?? '').trim().toUpperCase();
    const nom = clean(e.nom);
    const prenom = clean(e.prenom);
    if (!matricule.startsWith(`${cl.code}-`)) { erreurs.push(`${matricule || '?'} : ne correspond pas à la classe ${cl.nom}`); continue; }
    if (!nom || !prenom) { erreurs.push(`${matricule} : nom et prénom obligatoires`); continue; }
    if (vus.has(matricule)) continue;
    vus.add(matricule);
    valides.push({ matricule, nom, prenom });
  }

  const { data: existants } = await db.from('eleves').select('id, matricule').in('matricule', valides.map((v) => v.matricule));
  const idDe = Object.fromEntries((existants || []).map((x) => [x.matricule, x.id]));

  const res = await inBatches(valides, 8, async (v) => {
    try {
      if (idDe[v.matricule]) {
        const { error } = await db.from('eleves').update({ nom: v.nom, prenom: v.prenom, classe: cl.nom }).eq('id', idDe[v.matricule]);
        if (error) throw new Error(error.message);
        return { ...v, modifie: true };
      }
      const code = genCode();
      const { data, error } = await db.auth.admin.createUser({ email: emailOf(v.matricule), password: code, email_confirm: true });
      if (error) throw new Error(error.message);
      const { error: e2 } = await db.from('eleves').insert({ id: data.user.id, matricule: v.matricule, nom: v.nom, prenom: v.prenom, classe: cl.nom });
      if (e2) { await db.auth.admin.deleteUser(data.user.id); throw new Error(e2.message); }
      return { ...v, code };
    } catch (err) {
      return { ...v, erreur: err.message };
    }
  });

  res.filter((r) => r.erreur).forEach((r) => erreurs.push(`${r.matricule} : ${r.erreur}`));
  return {
    crees: res.filter((r) => r.code).map(({ matricule, nom, prenom, code }) => ({ matricule, nom, prenom, code })),
    modifies: res.filter((r) => r.modifie).length,
    erreurs,
  };
}

async function supprimerEleveParId(id) {
  // supprime les PDF de bulletins puis le compte (les notes et bulletins suivent en cascade)
  const { data: fichiers } = await db.storage.from('bulletins').list(id);
  if (fichiers?.length) await db.storage.from('bulletins').remove(fichiers.map((f) => `${id}/${f.name}`));
  const { error } = await db.auth.admin.deleteUser(id);
  if (error) throw new Error(error.message);
}

async function supprimerEleve({ matricule }) {
  const m = String(matricule ?? '').trim().toUpperCase();
  const { data } = await db.from('eleves').select('id').eq('matricule', m).maybeSingle();
  if (!data) throw new Error('Élève introuvable');
  await supprimerEleveParId(data.id);
  return { ok: true };
}

async function supprimerClasse({ code, confirmation }) {
  const { data: cl } = await db.from('classes').select('code, nom').eq('code', String(code ?? '').toUpperCase()).maybeSingle();
  if (!cl) throw new Error('Classe inconnue');
  if (String(confirmation ?? '').trim().toLowerCase() !== cl.nom.toLowerCase()) throw new Error('Confirmation incorrecte : tape le nom exact de la classe');
  const { data: eleves } = await db.from('eleves').select('id').eq('classe', cl.nom);
  await inBatches(eleves || [], 8, (e) => supprimerEleveParId(e.id));
  const { error } = await db.from('classes').delete().eq('code', cl.code);
  if (error) throw new Error(error.message);
  return { ok: true, supprimes: (eleves || []).length };
}

async function resetCode({ matricule }) {
  const m = String(matricule ?? '').trim().toUpperCase();
  const { data } = await db.from('eleves').select('id').eq('matricule', m).maybeSingle();
  if (!data) throw new Error('Élève introuvable');
  const code = genCode();
  const { error } = await db.auth.admin.updateUserById(data.id, { password: code });
  if (error) throw new Error(error.message);
  return { matricule: m, code };
}

async function resetClasse({ classe }) {
  const cl = await classeParNom(classe);
  const { data: liste } = await db.from('eleves').select('id, matricule, nom, prenom').eq('classe', cl.nom).order('matricule');
  const res = await inBatches(liste || [], 8, async (e) => {
    const code = genCode();
    const { error } = await db.auth.admin.updateUserById(e.id, { password: code });
    return error ? { matricule: e.matricule, erreur: error.message } : { matricule: e.matricule, nom: e.nom, prenom: e.prenom, code };
  });
  return { codes: res.filter((r) => r.code), erreurs: res.filter((r) => r.erreur).map((r) => `${r.matricule} : ${r.erreur}`) };
}

const ACTIONS = { enregistrer_eleves: enregistrerEleves, supprimer_eleve: supprimerEleve, supprimer_classe: supprimerClasse, reset_code: resetCode, reset_classe: resetClasse };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const { data: u } = token ? await db.auth.getUser(token) : { data: null };
    if (!u?.user) return res.status(401).json({ erreur: 'Session expirée, reconnecte-toi' });

    const { data: p } = await db.from('personnel').select('role').eq('id', u.user.id).maybeSingle();
    if (p?.role !== 'admin') return res.status(403).json({ erreur: 'Action réservée à l\'administration' });

    const { action, ...args } = req.body || {};
    const fn = ACTIONS[action];
    if (!fn) return res.status(400).json({ erreur: 'Action inconnue' });
    return res.status(200).json(await fn(args));
  } catch (e) {
    console.error(e);
    return res.status(400).json({ erreur: e.message || 'Erreur' });
  }
  }
                                     
