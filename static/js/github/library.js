// The lecture library on GitHub: which repositories, which course
// offerings and lectures they hold, reading a deck, and saving files back
// in one commit.
//
// Layout — the same repositories and course-offering folders Lectern uses,
// so Lectern's course page can link what Beamer+ saves, but nothing here
// depends on Lectern:
//
//   <name>-private  (private)                      <name>  (public, GitHub Pages)
//   csc258/f26/lectures/05 - Binary Arithmetic/    csc258/f26/slides/05 - Binary Arithmetic.pdf
//     05 - Binary Arithmetic.zip        original     (the annotated notes PDF)
//     05 - Binary Arithmetic.saved.zip  last save  csc258/f26/recordings/05 - Binary Arithmetic - recording (2026-10-19 14-05).mp4
//
// A course offering is a course in one term: <course>/<term>, e.g.
// csc258/f26. A lecture is a folder under its lectures/. The presentation
// (with its annotations, widget states and where you left off) stays in the
// private repository; the notes PDF and recordings, which are meant for
// students, go in the public one. A repository without a twin holds both.

import { api, GhError } from './auth.js';

const REPOS_KEY = 'beamer.github.repos';    // { priv, pub } full names
export const MAX_BYTES = 100e6;             // GitHub refuses files over 100 MB

const enc = p => p.split('/').map(encodeURIComponent).join('/');
export const isTerm = t => /^[wsf]\d{2}$/i.test(t);
const termKey = t => { const m = /^([wsf])(\d{2})$/i.exec(t); return m ? Number(m[2]) * 10 + { w: 1, s: 2, f: 3 }[m[1].toLowerCase()] : -1; };
export const termName = t => { const m = /^([wsf])(\d{2})$/i.exec(t); return m ? `${{ w: 'Winter', s: 'Summer', f: 'Fall' }[m[1].toLowerCase()]} 20${m[2]}` : t; };
/** A name that's safe as a file or folder name on every system. */
export const cleanName = s => String(s || '').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');

/* ─── repositories ────────────────────────────────────────────── */

/** Every repository the Beamer+ app was given, across the installations you can use. */
export async function listRepos() {
    const inst = await api('/user/installations?per_page=100');
    const out = [];
    for (const i of inst.installations || []) {
        for (let page = 1; page < 20; page++) {
            const r = await api(`/user/installations/${i.id}/repositories?per_page=100&page=${page}`);
            out.push(...(r.repositories || []));
            if ((r.repositories || []).length < 100) break;
        }
    }
    const seen = new Set();
    return out.filter(r => !seen.has(r.full_name) && seen.add(r.full_name))
              .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** The pair a chosen repository belongs to: <name>-private with <name>, matched by name.
 *  A repository with no twin Beamer+ can see is used for everything. */
export function pairFor(full, repos) {
    const find = n => repos.find(r => r.full_name.toLowerCase() === n.toLowerCase());
    const chosen = find(full);
    if (!chosen) return null;
    if (/-private$/i.test(full)) {
        const pub = find(full.replace(/-private$/i, ''));
        return { priv: chosen, pub: pub || chosen };
    }
    const priv = find(`${full}-private`);
    return { priv: priv || chosen, pub: chosen };
}

export function savedChoice() {
    try { return JSON.parse(localStorage.getItem(REPOS_KEY) || 'null'); } catch { return null; }
}
export function saveChoice(pair) {
    try {
        if (pair) localStorage.setItem(REPOS_KEY, JSON.stringify({ priv: pair.priv.full_name, pub: pair.pub.full_name }));
        else localStorage.removeItem(REPOS_KEY);
    } catch { /* ignore */ }
}
export async function loadChoice() {
    const c = savedChoice();
    if (!c?.priv) return null;
    try {
        const priv = await api(`/repos/${c.priv}`);
        const pub = c.pub && c.pub !== c.priv ? await api(`/repos/${c.pub}`).catch(() => priv) : priv;
        return { priv, pub };
    } catch (e) {
        if (e.status === 404) { saveChoice(null); return null; }
        throw e;
    }
}
export const twoRepos = pair => pair.priv.full_name !== pair.pub.full_name;

/* ─── what's in them ──────────────────────────────────────────── */

/** All files and folders in a repository (an empty repository has none). */
export async function tree(repo) {
    try { return (await api(`/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`)).tree || []; }
    catch (e) { if (e.status === 409 || e.status === 404) return []; throw e; }
}

/** Course offerings and their lectures.
 *  → Map "c/t" → { c, t, lectures: Map name → { name, decks: Map base → { original, saved } } }
 *  where original / saved are tree entries ({ path, sha, size }). */
export function readLibrary(privTree, pubTree) {
    const map = new Map();
    const off = (c, t) => {
        if ([c, t].some(x => x.startsWith('.') || x.startsWith('_'))) return null;
        const k = `${c}/${t}`;
        if (!map.has(k)) map.set(k, { c, t, lectures: new Map(), known: false });
        return map.get(k);
    };
    const lecture = (o, name) => {
        if (!o.lectures.has(name)) o.lectures.set(name, { name, decks: new Map() });
        return o.lectures.get(name);
    };
    for (const list of [privTree, pubTree]) {
        for (const x of list) {
            const p = x.path.split('/');
            if (x.type === 'tree' && p.length === 2) off(p[0], p[1]);
            // Files Lectern keeps there count too: the folder is a course offering
            // even when its term isn't named like one.
            if (x.type === 'blob' && p.length === 3 && /^(info\.html|grades\.json)$/.test(p[2])) { const o = off(p[0], p[1]); if (o) o.known = true; }
        }
    }
    for (const x of privTree) {
        const p = x.path.split('/');
        if (p.length < 4 || p[2] !== 'lectures') continue;
        const o = off(p[0], p[1]);
        if (!o) continue;
        o.known = true;
        if (x.type === 'tree' && p.length === 4) lecture(o, p[3]);
        if (x.type !== 'blob' || p.length !== 5) continue;
        const L = lecture(o, p[3]), file = p[4];
        let m;
        if ((m = /^(.+)\.saved\.zip$/i.exec(file))) {
            const d = L.decks.get(m[1]) || {}; d.saved = x; L.decks.set(m[1], d);
        } else if ((m = /^(.+)\.(zip|pdf)$/i.exec(file))) {
            const d = L.decks.get(m[1]) || {};
            // A ZIP beats a PDF of the same name (the PDF is usually its slides).
            if (!d.original || /\.zip$/i.test(file)) d.original = x;
            L.decks.set(m[1], d);
        }
    }
    for (const [k, o] of map) if (!o.known && !isTerm(o.t)) map.delete(k);
    return map;
}

export function sortedOfferings(lib) {
    return [...lib.values()].sort((a, b) => termKey(b.t) - termKey(a.t) || a.c.localeCompare(b.c) || a.t.localeCompare(b.t));
}
export function sortedLectures(o) {
    return [...o.lectures.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/* ─── where things go ─────────────────────────────────────────── */

export const lectureDir = (c, t, lecture) => `${c}/${t}/lectures/${lecture}`;
export const savedPath = (target) => `${lectureDir(target.c, target.t, target.lecture)}/${target.deck}.saved.zip`;
export const notesPath = (target) => `${target.c}/${target.t}/slides/${target.deck === target.lecture ? target.lecture : `${target.lecture} - ${target.deck}`}.pdf`;
export function recordingPath(target, startedAt, ext) {
    const d = new Date(startedAt), z = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}`;
    return `${target.c}/${target.t}/recordings/${target.lecture} - recording (${stamp}).${ext}`;
}

/* ─── reading ─────────────────────────────────────────────────── */

/** A file's bytes, by its blob sha (works for files up to GitHub's 100 MB). */
export function readBlob(repo, sha) {
    return api(`/repos/${repo.full_name}/git/blobs/${sha}`, { raw: true });
}

/** When a file was last committed (a Date), or null. */
export async function lastChanged(repo, path) {
    try {
        const c = await api(`/repos/${repo.full_name}/commits?path=${encodeURIComponent(path)}&per_page=1&sha=${encodeURIComponent(repo.default_branch)}`);
        const d = c?.[0]?.commit?.committer?.date || c?.[0]?.commit?.author?.date;
        return d ? new Date(d) : null;
    } catch { return null; }
}

/* ─── writing ─────────────────────────────────────────────────── */

const b64 = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new GhError(0, 'Couldn’t read a file to upload.'));
    r.readAsDataURL(blob);
});

/** Put files in a repository in one commit: [{ path, blob }]. Paths that already
 *  exist are replaced. If someone else committed meanwhile, the commit is
 *  rebuilt on top of theirs (each file is replaced whole, so nothing merges). */
export async function commitFiles(repo, files, message, onStep = () => {}) {
    const R = `/repos/${repo.full_name}`;
    const big = files.find(f => f.blob.size > MAX_BYTES);
    if (big) throw new GhError(413, `${big.path.split('/').pop()} is over GitHub's 100 MB limit.`);
    const entries = [];
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        onStep(`Uploading ${f.path.split('/').pop()}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}…`);
        const blob = await api(`${R}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: await b64(f.blob), encoding: 'base64' }) });
        entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    onStep('Committing…');
    for (let attempt = 0; ; attempt++) {
        let head;
        try { head = (await api(`${R}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`)).object.sha; }
        catch (e) {
            if (e.status === 404 || e.status === 409) throw new GhError(409, `${repo.full_name} is empty. Add a README to it on GitHub first, then save again.`);
            throw e;
        }
        const base = (await api(`${R}/git/commits/${head}`)).tree.sha;
        const t = await api(`${R}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: base, tree: entries }) });
        const c = await api(`${R}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: t.sha, parents: [head] }) });
        try {
            await api(`${R}/git/refs/heads/${encodeURIComponent(repo.default_branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
            return c.sha;
        } catch (e) {
            if ((e.status === 422 || e.status === 409) && attempt < 3) continue;   // moved on meanwhile: try again on top
            throw e;
        }
    }
}

export const encPath = enc;
