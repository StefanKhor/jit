"""Web dashboard for JIT."""

import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from pathlib import Path

from .indexer import load_index, get_all_skills, get_skill_by_id, index_items, parse_skill, clear_index
from .mcp_client import MCPClientManager

DASHBOARD_HTML = Path(__file__).resolve().parent.parent / "dashboard.html"


class JITDashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _check_auth(self):
        api_key = os.environ.get("JIT_API_KEY", "")
        if not api_key:
            return True
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:] == api_key
        return self.headers.get("X-API-Key", "") == api_key

    def _send_json(self, data, status=200):
        body = json.dumps(data, indent=2, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        # Serve HTML without auth so login form can load
        if path in ("/", "/index.html"):
            if DASHBOARD_HTML.exists():
                self._send_html(DASHBOARD_HTML.read_text())
            else:
                self._send_html("<h1>Dashboard not found</h1>")
            return
        if not self._check_auth():
            self._send_json({"error": "unauthorized"}, 401)
            return
        if path == "/api/status":
            self._api_status()
        elif path == "/api/health":
            self._api_health()
        elif path == "/api/config":
            self._api_config_get()
        elif path == "/api/skills":
            self._api_skills_list()
        elif path.startswith("/api/skills/"):
            self._api_skill_show(path.split("/api/skills/", 1)[1])
        elif path == "/api/mcp":
            self._api_mcp_list()
        elif path == "/api/mcp/configs":
            self._api_mcp_configs()
        elif path == "/api/stats":
            self._api_stats()
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        if not self._check_auth():
            self._send_json({"error": "unauthorized"}, 401)
            return
        path = urlparse(self.path).path
        body = self._read_body()
        if path == "/api/search":
            self._api_search(body)
        elif path == "/api/config":
            self._api_config_set(body)
        elif path == "/api/skills/add":
            self._api_skills_add(body)
        elif path == "/api/skills/toggle":
            self._api_skill_toggle(body)
        elif path == "/api/mcp/connect":
            self._api_mcp_connect(body)
        elif path == "/api/mcp/index":
            self._api_mcp_index(body)
        elif path == "/api/export":
            self._api_export()
        elif path == "/api/import":
            self._api_import(body)
        elif path == "/api/clear":
            self._api_clear()
        else:
            self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        if not self._check_auth():
            self._send_json({"error": "unauthorized"}, 401)
            return
        path = urlparse(self.path).path
        if path.startswith("/api/skills/"):
            self._api_skill_remove(path.split("/api/skills/", 1)[1])
        else:
            self._send_json({"error": "not found"}, 404)

    def _api_health(self):
        import time
        from . import __version__
        self._send_json({"status": "healthy", "version": __version__, "timestamp": time.time()})

    def _api_config_get(self):
        from .config_manager import load_config, is_first_run
        cfg = load_config()
        # Don't expose full API key, just whether it's set
        safe = dict(cfg)
        if safe.get("nebius_api_key"):
            safe["nebius_api_key"] = "***" + safe["nebius_api_key"][-4:]
        if safe.get("api_key"):
            safe["api_key"] = "***" + safe["api_key"][-4:]
        safe["first_run"] = is_first_run()
        self._send_json(safe)

    def _api_config_set(self, body):
        from .config_manager import load_config, save_config, complete_first_run
        cfg = load_config()
        for key in ["nebius_api_key", "nebius_api_base", "nemotron_nano_model", "nemotron_ultra_model"]:
            if key in body and body[key]:
                cfg[key] = body[key]
        if body.get("complete_setup"):
            complete_first_run()
        save_config(cfg)
        self._send_json({"saved": True})

    def _api_status(self):
        index, conn = load_index()
        if conn is None:
            self._send_json({"indexed": 0, "skills": 0, "tools": 0, "error": "no index"})
            return
        skills = get_all_skills(conn)
        skill_count = sum(1 for s in skills if s.get("kind") == "skill")
        tool_count = sum(1 for s in skills if s.get("kind") == "tool")
        cats = set()
        for s in skills:
            cats.update(s.get("categories", []))
        conn.close()
        self._send_json({"indexed": len(skills), "skills": skill_count, "tools": tool_count, "categories": sorted(cats)})

    def _api_skills_list(self):
        index, conn = load_index()
        if conn is None:
            self._send_json({"skills": []})
            return
        items = [s for s in get_all_skills(conn) if s.get("kind") == "skill"]
        conn.close()
        self._send_json({"skills": [{"name": s["name"], "description": s["description"], "categories": s.get("categories", []), "aliases": s.get("aliases", []), "path": s.get("path", ""), "enabled": s.get("enabled", True)} for s in items]})

    def _api_skill_show(self, name):
        index, conn = load_index()
        if conn is None:
            self._send_json({"error": "no index"}, 404)
            return
        skill = get_skill_by_id(conn, name)
        conn.close()
        if not skill:
            self._send_json({"error": "not found"}, 404)
            return
        self._send_json({"name": skill["name"], "description": skill["description"], "categories": skill.get("categories", []), "aliases": skill.get("aliases", []), "path": skill.get("path", ""), "body": skill.get("body", ""), "when_to_use": skill.get("when_to_use", ""), "enabled": skill.get("enabled", True)})

    def _api_skill_remove(self, name):
        index, conn = load_index()
        if conn is None:
            self._send_json({"error": "no index"}, 404)
            return
        row = conn.execute("SELECT id FROM skills WHERE id = ? AND kind = 'skill'", (name,)).fetchone()
        if not row:
            conn.close()
            self._send_json({"error": "not found"}, 404)
            return
        conn.execute("DELETE FROM skills WHERE id = ?", (name,))
        conn.commit()
        conn.close()
        self._send_json({"removed": name})

    def _api_skill_toggle(self, body):
        name = body.get("name", "")
        enabled = body.get("enabled", True)
        if not name:
            self._send_json({"error": "name required"}, 400)
            return
        index, conn = load_index()
        if conn is None:
            self._send_json({"error": "no index"}, 404)
            return
        row = conn.execute("SELECT id FROM skills WHERE id = ?", (name,)).fetchone()
        if not row:
            conn.close()
            self._send_json({"error": "not found"}, 404)
            return
        conn.execute("UPDATE skills SET enabled = ? WHERE id = ?", (1 if enabled else 0, name))
        conn.commit()
        conn.close()
        self._send_json({"name": name, "enabled": enabled})

    def _api_skills_add(self, body):
        path = body.get("path", "")
        if not path:
            self._send_json({"error": "path required"}, 400)
            return
        from pathlib import Path as P
        p = P(path).expanduser()
        if p.is_dir():
            files = list(p.rglob("SKILL.md")) + list(p.glob("*.md"))
        elif p.is_file():
            files = [p]
        else:
            self._send_json({"error": f"path not found: {path}"}, 404)
            return
        skills = []
        for f in files:
            try:
                skills.append(parse_skill(f))
            except Exception:
                pass
        if not skills:
            self._send_json({"error": "no skills parsed"}, 400)
            return
        added, skipped, errors = index_items(skills, "skill")
        self._send_json({"added": added, "skipped": skipped, "errors": errors})

    def _api_mcp_list(self):
        mgr = MCPClientManager()
        mgr.load_configs()
        statuses = mgr.get_status()
        self._send_json({"servers": [{"name": name, "status": st["status"], "tool_count": st["tool_count"], "error": st.get("error")} for name, st in statuses.items()]})

    def _api_mcp_configs(self):
        mgr = MCPClientManager()
        paths = mgr._default_config_paths()
        self._send_json({"paths": [{"path": str(p), "exists": p.exists()} for p in paths]})

    def _api_mcp_connect(self, body):
        name = body.get("server", "")
        if not name:
            self._send_json({"error": "server required"}, 400)
            return
        mgr = MCPClientManager()
        mgr.load_configs()
        connected = mgr.connect(name)
        if not connected:
            status = mgr.get_status().get(name, {})
            self._send_json({"error": status.get("error", "connection failed")}, 500)
            return
        tools = mgr.get_tools(name)
        mgr.disconnect(name)
        self._send_json({"connected": True, "server": name, "tools": [{"name": t["name"], "description": t.get("description", "")} for t in tools]})

    def _api_mcp_index(self, body):
        name = body.get("server", "")
        if not name:
            self._send_json({"error": "server required"}, 400)
            return
        mgr = MCPClientManager()
        mgr.load_configs()
        connected = mgr.connect(name)
        if not connected:
            status = mgr.get_status().get(name, {})
            self._send_json({"error": status.get("error", "connection failed")}, 500)
            return
        manifests = mgr.index_tools(name)
        added, skipped, errors = index_items(manifests, "tool")
        mgr.disconnect(name)
        self._send_json({"added": added, "skipped": skipped, "errors": errors})

    def _api_search(self, body):
        intent = body.get("intent", "")
        if not intent:
            self._send_json({"error": "intent required"}, 400)
            return
        from .retriever import retrieve
        result = retrieve(intent)
        self._send_json({"result": result})

    def _api_stats(self):
        index, conn = load_index()
        if conn is None:
            self._send_json({"error": "no index"})
            return
        skills = get_all_skills(conn)
        skill_count = sum(1 for s in skills if s.get("kind") == "skill")
        tool_count = sum(1 for s in skills if s.get("kind") == "tool")
        cats = {}
        for s in skills:
            for c in s.get("categories", []):
                cats[c] = cats.get(c, 0) + 1
        conn.close()
        static_tokens = len(skills) * 500 + 200
        jit_tokens = 200 + 500
        self._send_json({"total_indexed": len(skills), "skills": skill_count, "tools": tool_count, "categories": cats, "tokens": {"static": static_tokens, "jit": jit_tokens, "saved": static_tokens - jit_tokens, "reduction_pct": round((1 - jit_tokens / static_tokens) * 100, 1) if static_tokens > 0 else 0}})

    def _api_export(self):
        index, conn = load_index()
        if conn is None:
            self._send_json({"error": "no index"}, 404)
            return
        skills = get_all_skills(conn)
        conn.close()
        self._send_json({"version": 1, "items": skills})

    def _api_import(self, body):
        items = body.get("items", [])
        if not items:
            self._send_json({"error": "no items"}, 400)
            return
        skills = [i for i in items if i.get("kind", "skill") == "skill"]
        tools = [i for i in items if i.get("kind") == "tool"]
        total_added = 0
        total_skipped = 0
        errors = []
        if skills:
            added, skipped, errs = index_items(skills, "skill")
            total_added += added
            total_skipped += skipped
            errors.extend(errs)
        if tools:
            added, skipped, errs = index_items(tools, "tool")
            total_added += added
            total_skipped += skipped
            errors.extend(errs)
        self._send_json({"added": total_added, "skipped": total_skipped, "errors": errors})

    def _api_clear(self):
        clear_index()
        self._send_json({"cleared": True})


def start_dashboard(host="127.0.0.1", port=3000):
    server = HTTPServer((host, port), JITDashboardHandler)
    print(f"JIT Dashboard running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    start_dashboard()
