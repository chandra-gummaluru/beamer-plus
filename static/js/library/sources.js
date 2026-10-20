// Where presentations live on GitHub: a repository, as the browser in
// library/ui.js sees it:
//
//   { kind, id, name, limit, where,
//     list(path) → [{ name, path, type: 'dir'|'file', size?, ... }],
//     read(entry), changed(entry), write([{ path, blob }], message, onStep) }
//
// Beamer+ imposes no layout: you browse the folders and pick.

import * as GH from '../github/library.js';

export function githubSource(repo) {
    // The whole tree is read once, then browsed here; a save adds to it.
    let index = null;           // Promise of Map dirPath → { dirs: Set, files: Map name → entry }
    const build = (tree) => {
        const m = new Map([['', { dirs: new Set(), files: new Map() }]]);
        const dir = p => { if (!m.has(p)) m.set(p, { dirs: new Set(), files: new Map() }); return m.get(p); };
        const addDirs = (p) => {
            const parts = p.split('/');
            for (let i = 1; i <= parts.length; i++) {
                const sub = parts.slice(0, i).join('/'), parent = parts.slice(0, i - 1).join('/');
                dir(parent).dirs.add(parts[i - 1]); dir(sub);
            }
        };
        for (const x of tree) {
            if (x.type === 'tree') addDirs(x.path);
            else if (x.type === 'blob') {
                const i = x.path.lastIndexOf('/'), d = i < 0 ? '' : x.path.slice(0, i);
                if (d) addDirs(d);
                dir(d).files.set(x.path.slice(i + 1), { name: x.path.slice(i + 1), path: x.path, type: 'file', size: x.size, sha: x.sha });
            }
        }
        return m;
    };
    const load = () => (index ||= GH.tree(repo).then(build).catch(e => { index = null; throw e; }));
    return {
        kind: 'github',
        id: `github:${repo.full_name}`,
        name: repo.full_name,
        limit: GH.MAX_BYTES,
        where: 'GitHub',
        repo,
        async list(path) {
            const d = (await load()).get(path);
            if (!d) return [];
            return [...[...d.dirs].map(n => ({ name: n, path: path ? `${path}/${n}` : n, type: 'dir' })), ...d.files.values()];
        },
        read: e => GH.readBlob(repo, e.sha),
        changed: e => GH.lastChanged(repo, e.path),
        async write(files, msg, onStep) {
            if (!files.length) return;
            await GH.commitFiles(repo, files, msg, onStep);
            index = null;                       // read it again next time
        },
        refresh() { index = null; },
    };
}
