"""Shared bits for the browser walkthroughs (flow_*.py): where Beamer+ runs,
where screenshots go, a tiny PDF and ZIP, and a stand-in for the folder
picker (the browser's private file system, so no dialog opens).
"""
import io
import os
import zipfile

BASE = os.environ.get("BEAMER_URL", "http://localhost:5001/")
OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)


def make_pdf(pages=6, title="Binary Arithmetic"):
    """A tiny PDF without extra libraries: one line of text per page."""
    objs, kids = [], []
    font = 3
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(None)                                   # pages, filled below
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
    for i in range(pages):
        text = f"BT /F1 24 Tf 30 140 Td ({title} - slide {i + 1}) Tj ET".encode()
        objs.append(b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream")
        content = len(objs)
        objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 363 272] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>" % (content, font))
        kids.append(len(objs))
    objs[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), pages)
    out, offs = io.BytesIO(), []
    out.write(b"%PDF-1.4\n")
    for n, o in enumerate(objs, 1):
        offs.append(out.tell())
        out.write(b"%d 0 obj\n" % n + o + b"\nendobj\n")
    x = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for o in offs:
        out.write(b"%010d 00000 n \n" % o)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x))
    return out.getvalue()


def make_zip(pdf):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("slides.pdf", pdf)
    return b.getvalue()


# showDirectoryPicker() answers with a folder in the browser's private file
# system (OPFS) instead of opening a dialog; its handles don't do permissions,
# so those always say yes; window.__pick names the folder the next pick
# returns ('Courses' or 'Saves'). Headless Chromium crashes reading an OPFS
# handle back from IndexedDB, so a remembered folder is stored as a marker
# and handed back as the handle. FOLDER_RESET empties the folder.
FAKE_FOLDER = """
(() => {
  // The folder window hands back 'Courses', or the folder named in
  // window.__pick ('Saves', 'Saves/csc258'). The Open window hands back the
  // file at window.__open ('Courses/…'). Each records where it was asked to
  // start (window.__startIn: a handle's name). Cancel: window.__cancel = true.
  if (!navigator.storage?.getDirectory) return;           // not a page that can have one
  const NAMES = ['Courses', 'Saves'];
  const get = async (path, create = true) => { let d = await navigator.storage.getDirectory();
    for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create }); return d; };
  window.__fakeFolders = {};
  for (const n of NAMES) get(n).then(h => { window.__fakeFolders[n] = h; });
  const cancel = () => { if (window.__cancel) { window.__cancel = false; throw new DOMException('cancelled', 'AbortError'); } };
  window.showDirectoryPicker = async (o = {}) => { window.__startIn = o.startIn?.name ?? o.startIn; cancel();
    const p = window.__pick || 'Courses'; const h = await get(p); window.__fakeFolders[h.name] = h; return h; };
  window.showOpenFilePicker = async (o = {}) => { window.__openTypes = o.types; cancel();
    const parts = (window.__open || '').split('/'); const d = await get(parts.slice(0, -1).join('/'), false);
    return [await d.getFileHandle(parts.at(-1))]; };
  const P = FileSystemHandle.prototype;
  P.queryPermission = async () => 'granted';
  P.requestPermission = async () => 'granted';
  const put = IDBObjectStore.prototype.put;
  // (This browser can't keep a private-file-system handle in IndexedDB: a
  // folder is kept by name; a handle inside an object is dropped.)
  const keep = v => v instanceof FileSystemHandle ? '__fake_folder__:' + v.name
    : v && v.constructor === Object ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x instanceof FileSystemHandle ? null : x])) : v;
  IDBObjectStore.prototype.put = function (v, ...rest) { return put.call(this, keep(v), ...rest); };
  const res = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
  Object.defineProperty(IDBRequest.prototype, 'result', { configurable: true,
    get() { const r = res.get.call(this);
      return typeof r === 'string' && r.startsWith('__fake_folder__:') ? window.__fakeFolders[r.slice(16)] : r; } });
})();
"""
FOLDER_RESET = """async () => { const r = await navigator.storage.getDirectory(); for await (const [n] of r.entries()) await r.removeEntry(n, { recursive: true }); }"""
# Put files in the folder: { "a/b/c.zip": <base64> }.
FOLDER_PUT = """async (files) => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Courses', { create: true });
  for (const [path, b64] of Object.entries(files)) {
    const parts = path.split('/'); let d = root;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); await w.close();
  }
}"""
# Every file in a folder ('Courses' unless named): { path: size }.
FOLDER_LS = """async (name) => {
  const out = {};
  const walk = async (d, pre) => { for await (const [n, h] of d.entries()) {
    if (h.kind === 'directory') await walk(h, pre + n + '/'); else out[pre + n] = (await h.getFile()).size; } };
  await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(name || 'Courses', { create: true }), '');
  return out;
}"""
