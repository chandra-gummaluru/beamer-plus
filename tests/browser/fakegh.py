"""A small in-memory GitHub API for trying Beamer+'s GitHub features in Playwright (context.route)."""
import base64
import hashlib
import json
import re
import time
from urllib.parse import parse_qs, unquote, urlparse

CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*"}


def sha(b):
    return hashlib.sha1(b + str(time.time_ns()).encode()).hexdigest()


class Repo:
    def __init__(self, full, private, files=None):
        self.full, self.private = full, private
        self.blobs = {}                       # sha -> bytes
        self.commits = {}                     # sha -> {files: {path: blobsha}, msg, date}
        self.trees = {}                       # sha -> {path: blobsha}
        files = {p: (v if isinstance(v, bytes) else v.encode()) for p, v in (files or {}).items()}
        self.head = self._commit({p: self._blob(b) for p, b in files.items()}, "init")

    def _blob(self, b):
        s = sha(b)
        self.blobs[s] = b
        return s

    def _commit(self, files, msg, parent=None):
        t = sha(b"t")
        self.trees[t] = dict(files)
        c = sha(b"c")
        self.commits[c] = {"files": dict(files), "tree": t, "msg": msg, "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "parent": parent}
        return c

    def files(self):
        return {p: self.blobs[s] for p, s in self.commits[self.head]["files"].items()}

    def info(self):
        owner, name = self.full.split("/")
        return {"full_name": self.full, "name": name, "private": self.private, "default_branch": "main", "owner": {"login": owner}}


class FakeGitHub:
    def __init__(self):
        self.repos = {}
        self.calls = []

    def add(self, repo):
        self.repos[repo.full] = repo

    def handle(self, route):
        req = route.request
        u = urlparse(req.url)
        body = None
        if req.post_data_buffer:
            try:
                body = json.loads(req.post_data_buffer)
            except Exception:
                body = None
        self.calls.append((req.method, unquote(u.path)))
        status, data, raw = self.dispatch(req.method, u.path, parse_qs(u.query), body, req.headers.get("accept", ""))
        if raw is not None:
            route.fulfill(status=status, headers={**CORS, "Content-Type": "application/octet-stream"}, body=raw)
        else:
            route.fulfill(status=status, headers={**CORS, "Content-Type": "application/json"},
                          body=json.dumps(data) if data is not None else "")

    def dispatch(self, m, path, q, body, accept):
        if m == "OPTIONS":
            return 204, None, None
        if path == "/user":
            return 200, {"login": "chandra-gummaluru", "avatar_url": ""}, None
        if path == "/user/installations":
            return 200, {"installations": [{"id": 1}]}, None
        if path == "/user/installations/1/repositories":
            return 200, {"repositories": [r.info() for r in self.repos.values()]}, None
        mm = re.match(r"^/repos/([^/]+/[^/]+)(/.*)?$", path)
        if not mm or mm.group(1) not in self.repos:
            return 404, {"message": "Not Found"}, None
        r, rest = self.repos[mm.group(1)], mm.group(2) or ""
        if rest == "":
            return 200, r.info(), None
        if rest.startswith("/git/trees/") and m == "GET":
            ref = unquote(rest[len("/git/trees/"):])
            files = r.trees.get(ref) or r.commits[r.head]["files"]
            out, dirs = [], set()
            for p, s in files.items():
                parts = p.split("/")
                for i in range(1, len(parts)):
                    dirs.add("/".join(parts[:i]))
                out.append({"path": p, "type": "blob", "sha": s, "size": len(r.blobs[s]), "mode": "100644"})
            out += [{"path": d, "type": "tree", "sha": "x"} for d in sorted(dirs)]
            return 200, {"tree": out, "truncated": False}, None
        if rest.startswith("/git/blobs/") and m == "GET":
            s = rest[len("/git/blobs/"):]
            if s not in r.blobs:
                return 404, {"message": "Not Found"}, None
            if "raw" in accept:
                return 200, None, r.blobs[s]
            return 200, {"sha": s, "content": base64.b64encode(r.blobs[s]).decode(), "encoding": "base64"}, None
        if rest == "/git/blobs" and m == "POST":
            return 201, {"sha": r._blob(base64.b64decode(body["content"]))}, None
        if rest.startswith("/git/ref/heads/"):
            return 200, {"object": {"sha": r.head}}, None
        if rest.startswith("/git/commits/") and m == "GET":
            c = r.commits[rest.split("/")[-1]]
            return 200, {"tree": {"sha": c["tree"]}}, None
        if rest == "/git/trees" and m == "POST":
            files = dict(r.trees[body["base_tree"]])
            for e in body["tree"]:
                if e.get("sha") is None:
                    files.pop(e["path"], None)
                else:
                    files[e["path"]] = e["sha"]
            t = sha(b"t")
            r.trees[t] = files
            return 201, {"sha": t}, None
        if rest == "/git/commits" and m == "POST":
            c = sha(b"c")
            r.commits[c] = {"files": dict(r.trees[body["tree"]]), "tree": body["tree"], "msg": body["message"],
                            "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "parent": body["parents"][0]}
            return 201, {"sha": c}, None
        if rest.startswith("/git/refs/heads/") and m == "PATCH":
            if r.commits[body["sha"]]["parent"] != r.head:
                return 422, {"message": "Update is not a fast forward"}, None
            r.head = body["sha"]
            return 200, {"object": {"sha": r.head}}, None
        if rest == "/commits" and m == "GET":
            p = q.get("path", [""])[0]
            c, out = r.head, []
            while c and not out:
                cur = r.commits[c]
                par = cur["parent"]
                if p in cur["files"] and (not par or r.commits[par]["files"].get(p) != cur["files"][p]):
                    out.append({"sha": c, "commit": {"committer": {"date": cur["date"]}, "message": cur["msg"]}})
                c = par
            return 200, out, None
        return 404, {"message": f"fake: {m} {rest}"}, None
