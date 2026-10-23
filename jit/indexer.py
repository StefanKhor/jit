"""Index skills: discover, parse, embed, store."""

import json
import sqlite3
from pathlib import Path

import faiss
import frontmatter
import numpy as np
from sentence_transformers import SentenceTransformer

from .config import (
    DEFAULT_SKILL_PATHS,
    EMBEDDING_MODEL,
    INDEX_DIR,
    INDEX_FILE,
    META_DB,
    NEBIUS_API_BASE,
    NEBIUS_API_KEY,
    NEMOTRON_NANO_MODEL,
)

# Lazy-loaded embedding model
_embed_model = None


def get_embed_model():
    global _embed_model
    if _embed_model is None:
        _embed_model = SentenceTransformer(EMBEDDING_MODEL)
    return _embed_model


def discover_skills(paths=None):
    """Walk skill directories and find all SKILL.md files."""
    if paths is None:
        paths = DEFAULT_SKILL_PATHS
    skills = []
    for base in paths:
        base = Path(base).expanduser()
        if not base.exists():
            continue
        # Direct SKILL.md files in subdirectories
        for skill_file in base.rglob("SKILL.md"):
            skills.append(skill_file)
        # Also check for .md files directly in the directory
        for md_file in base.glob("*.md"):
            if md_file.name != "SKILL.md":
                skills.append(md_file)
    return sorted(set(skills))


def parse_skill(path):
    """Parse a skill file into (metadata, body)."""
    path = Path(path)
    post = frontmatter.load(str(path))
    meta = dict(post.metadata)
    body = post.content.strip()

    # Ensure required fields
    if "name" not in meta:
        meta["name"] = path.parent.name if path.name == "SKILL.md" else path.stem
    if "description" not in meta:
        meta["description"] = body[:100].replace("\n", " ") if body else "No description"
    if "categories" not in meta:
        meta["categories"] = []
    if "when_to_use" not in meta:
        meta["when_to_use"] = meta.get("description", "")

    return {
        "id": meta["name"],
        "name": meta["name"],
        "description": meta["description"],
        "when_to_use": meta.get("when_to_use", meta.get("description", "")),
        "categories": meta["categories"],
        "body": body,
        "path": str(path),
        "aliases": meta.get("aliases", []),
    }


def generate_aliases(skill, nano_client=None):
    """Use Nemotron Nano to generate alias phrases for better recall."""
    if nano_client is None:
        return skill
    try:
        prompt = (
            f"Given this skill:\n"
            f"Name: {skill['name']}\n"
            f"Description: {skill['description']}\n"
            f"When to use: {skill['when_to_use']}\n\n"
            f"Generate 5 short alternative phrases a user might say when they need this skill. "
            f"Return ONLY a JSON array of strings, no explanation."
        )
        response = nano_client.chat.completions.create(
            model=NEMOTRON_NANO_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=200,
        )
        text = response.choices[0].message.content.strip()
        # Parse JSON array
        if text.startswith("["):
            aliases = json.loads(text)
            skill["aliases"] = [str(a) for a in aliases[:5]]
    except Exception:
        pass  # Aliases are optional
    return skill


def build_embedding_text(item):
    """Build the text to embed for a skill or tool."""
    if item.get("kind") == "tool":
        parts = [
            item.get("name", ""),
            item.get("description", ""),
            " ".join(item.get("params", [])),
            " ".join(item.get("required", [])),
            item.get("server", ""),
        ]
        return " | ".join(p for p in parts if p)
    # Skill — concise embedding focused on name + intent
    name = item["name"].replace("-", " ").replace("_", " ")
    aliases = item.get("aliases", [])
    parts = [
        name,
        item.get("when_to_use", ""),
        item["description"],
        " ".join(aliases),
    ]
    return " | ".join(p for p in parts if p)


def init_db(db_path):
    """Initialize SQLite database for skill/tool metadata."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS skills (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            when_to_use TEXT,
            categories TEXT,
            body TEXT,
            path TEXT,
            aliases TEXT,
            embedding_idx INTEGER,
            kind TEXT DEFAULT 'skill',
            enabled INTEGER DEFAULT 1
        )
    """)
    # Migrate: add kind column if missing
    try:
        conn.execute("ALTER TABLE skills ADD COLUMN kind TEXT DEFAULT 'skill'")
    except sqlite3.OperationalError:
        pass
    # Migrate: add enabled column if missing
    try:
        conn.execute("ALTER TABLE skills ADD COLUMN enabled INTEGER DEFAULT 1")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    return conn


def index_items(items, item_type="skill", nano_client=None):
    """Index a list of items (skills or tools). Returns (added, skipped, errors)."""
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    conn = init_db(META_DB)

    # Ensure kind column exists
    try:
        conn.execute("ALTER TABLE skills ADD COLUMN kind TEXT DEFAULT 'skill'")
    except sqlite3.OperationalError:
        pass  # Column already exists
    # Ensure enabled column exists
    try:
        conn.execute("ALTER TABLE skills ADD COLUMN enabled INTEGER DEFAULT 1")
    except sqlite3.OperationalError:
        pass  # Column already exists

    existing = {row[0] for row in conn.execute("SELECT id FROM skills").fetchall()}

    added = 0
    skipped = 0
    errors = []

    new_items = []
    for item in items:
        item["kind"] = item_type
        if nano_client and item_type == "skill":
            item = generate_aliases(item, nano_client)
        if item["id"] in existing:
            skipped += 1
            continue
        new_items.append(item)

    if not new_items:
        conn.close()
        return added, skipped, errors

    model = get_embed_model()
    texts = [build_embedding_text(i) for i in new_items]
    embeddings = model.encode(texts, normalize_embeddings=True)

    if INDEX_FILE.exists():
        index = faiss.read_index(str(INDEX_FILE))
    else:
        index = faiss.IndexFlatIP(embeddings.shape[1])

    offset = index.ntotal
    index.add(embeddings.astype(np.float32))
    faiss.write_index(index, str(INDEX_FILE))

    for i, item in enumerate(new_items):
        try:
            conn.execute(
                """INSERT OR REPLACE INTO skills
                   (id, name, description, when_to_use, categories, body, path, aliases, embedding_idx, kind, enabled)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    item["id"],
                    item["name"],
                    item.get("description", ""),
                    item.get("when_to_use", item.get("description", "")),
                    json.dumps(item.get("categories", [])),
                    item.get("body", ""),
                    item.get("path", ""),
                    json.dumps(item.get("aliases", [])),
                    offset + i,
                    item_type,
                    1,  # enabled by default
                ),
            )
            added += 1
        except Exception as e:
            errors.append(f"{item['id']}: {e}")

    conn.commit()
    conn.close()
    return added, skipped, errors


# Keep backward compat
def index_skills(skills, nano_client=None, skill_paths=None):
    return index_items(skills, "skill", nano_client)


def load_index():
    """Load FAISS index and SQLite metadata. Returns (index, conn)."""
    if not INDEX_FILE.exists() or not META_DB.exists():
        return None, None
    index = faiss.read_index(str(INDEX_FILE))
    conn = sqlite3.connect(str(META_DB))
    conn.row_factory = sqlite3.Row
    return index, conn


def get_skill_by_id(conn, skill_id):
    """Get a skill's full record from SQLite."""
    row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "when_to_use": row["when_to_use"],
        "categories": json.loads(row["categories"] or "[]"),
        "body": row["body"],
        "path": row["path"],
        "aliases": json.loads(row["aliases"] or "[]"),
        "embedding_idx": row["embedding_idx"],
        "enabled": bool(row["enabled"]) if "enabled" in row.keys() else True,
    }


def get_all_skills(conn):
    """Get all skills from SQLite."""
    rows = conn.execute("SELECT * FROM skills").fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "description": r["description"],
            "when_to_use": r["when_to_use"],
            "categories": json.loads(r["categories"] or "[]"),
            "body": r["body"],
            "path": r["path"],
            "aliases": json.loads(r["aliases"] or "[]"),
            "embedding_idx": r["embedding_idx"],
            "kind": r["kind"] if "kind" in r.keys() else "skill",
            "enabled": bool(r["enabled"]) if "enabled" in r.keys() else True,
        }
        for r in rows
    ]


def clear_index():
    """Clear the entire index."""
    import shutil
    if INDEX_DIR.exists():
        shutil.rmtree(INDEX_DIR)
    INDEX_DIR.mkdir(parents=True, exist_ok=True)