"""Tests for JIT indexer."""

import json
import tempfile
from pathlib import Path

import pytest

from jit.indexer import parse_skill, init_db, get_all_skills, clear_index, load_index


def test_parse_skill(tmp_path):
    skill_file = tmp_path / "SKILL.md"
    skill_file.write_text("""---
name: test-skill
description: A test skill
categories: [testing]
aliases: [test, demo]
---
# Test Skill

This is a test skill body.
""")
    skill = parse_skill(skill_file)
    assert skill["name"] == "test-skill"
    assert skill["description"] == "A test skill"
    assert skill["categories"] == ["testing"]
    assert skill["aliases"] == ["test", "demo"]
    assert "test skill body" in skill["body"]


def test_parse_skill_minimal(tmp_path):
    skill_file = tmp_path / "minimal.md"
    skill_file.write_text("# Just a markdown file\n\nSome content.")
    skill = parse_skill(skill_file)
    assert skill["name"] == "minimal"
    assert "Some content" in skill["body"]


def test_init_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        conn = init_db(db_path)
        assert conn is not None
        # Check table exists
        tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        assert any("skills" in t[0] for t in tables)
        conn.close()


def test_clear_index():
    clear_index()
    index, conn = load_index()
    assert conn is None or index is None