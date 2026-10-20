// GitHub calls for the presentation browser: the repositories Beamer+ may
// use, a repository's files, reading one, and saving files in one commit.
// Beamer+ doesn't impose a layout: you browse the repository's folders and
// pick where things go (library/ui.js).

import { api, GhError } from './auth.js';

export const MAX_BYTES = 100e6;             // GitHub refuses files over 100 MB

/** A name that's safe as a file or folder name on every system. */
export const cleanName = s => String(s || '').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');

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

/** All files and folders in a repository (an empty repository has none). */
export async function tree(repo) {
    try { return (await api(`/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`)).tree || []; }
    catch (e) { if (e.status === 409 || e.status === 404) return []; throw e; }
}

/** Course offerings and their lectures.
 *  → Map "c/t" → { c, t, lectures: Map name → { name, decks: Map base → { original, saved } } }
 *  where original / saved are tree entries ({ path, sha, size }). */
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

