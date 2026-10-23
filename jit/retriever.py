"""Retrieval: BM25 + vector search + optional Nemotron Nano rerank."""

import json
import sqlite3
from pathlib import Path

import numpy as np
from rank_bm25 import BM25Okapi

from .config import (
    CONFIDENCE_THRESHOLD,
    META_DB,
    NEBIUS_API_BASE,
    NEBIUS_API_KEY,
    NEMOTRON_NANO_MODEL,
    TOP_K_RETRIEVE,
)
from .indexer import get_all_skills, get_embed_model, load_index


def _tokenize(text):
    """Simple whitespace + lowercase tokenizer for BM25."""
    return text.lower().split()


def _build_bm25(skills):
    """Build a BM25 index from skills."""
    corpus = []
    for s in skills:
        text = " ".join([
            s["name"],
            s["description"],
            s["when_to_use"],
            " ".join(s.get("categories", [])),
            " ".join(s.get("aliases", [])),
        ])
        corpus.append(_tokenize(text))
    return BM25Okapi(corpus)


def _rrf_merge(bm25_results, vector_results, k=60):
    """Reciprocal Rank Fusion to merge two ranked lists."""
    scores = {}
    for rank, idx in enumerate(bm25_results):
        scores[idx] = scores.get(idx, 0) + 1.0 / (k + rank + 1)
    for rank, idx in enumerate(vector_results):
        scores[idx] = scores.get(idx, 0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def _nano_rerank(intent, candidates, nano_client):
    """Use Nemotron Nano to rerank candidates. Returns list of (skill, score)."""
    if not nano_client or not candidates:
        return [(s, 0.5) for s in candidates]

    # Build prompt
    skill_list = "\n".join(
        f"{i+1}. [{c['name']}] {c['description']} (when: {c['when_to_use']})"
        for i, c in enumerate(candidates)
    )
    prompt = (
        f"User intent: \"{intent}\"\n\n"
        f"Candidate skills:\n{skill_list}\n\n"
        f"Score each candidate 0-3 for relevance to the intent. "
        f"Return ONLY a JSON array of numbers, e.g. [3, 1, 0, 2]. "
        f"No explanation."
    )

    try:
        response = nano_client.chat.completions.create(
            model=NEMOTRON_NANO_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=100,
        )
        text = response.choices[0].message.content.strip()
        # Parse JSON array
        if text.startswith("["):
            scores = json.loads(text)
            if len(scores) == len(candidates):
                return [(c, min(max(s, 0), 3) / 3.0) for c, s in zip(candidates, scores)]
    except Exception:
        pass

    # Fallback: return hybrid scores
    return [(c, c.get("_hybrid_score", 0.5)) for c in candidates]


def retrieve(intent, use_rerank=True, top_k=1):
    """
    Retrieve the best skill for an intent.

    Returns:
        dict with {name, skill (body), confidence} or None
    """
    index, conn = load_index()
    if index is None or conn is None:
        return None

    skills = get_all_skills(conn)
    if not skills:
        conn.close()
        return None

    # Filter disabled skills
    skills = [s for s in skills if s.get("enabled", True)]

    # Build BM25
    bm25 = _build_bm25(skills)
    bm25_scores = bm25.get_scores(_tokenize(intent))
    bm25_ranked = sorted(range(len(skills)), key=lambda i: bm25_scores[i], reverse=True)

    # Vector search (returns cosine similarity for normalized vectors)
    model = get_embed_model()
    intent_vec = model.encode([intent], normalize_embeddings=True).astype("float32")
    distances, indices = index.search(intent_vec, min(TOP_K_RETRIEVE, len(skills)))
    vector_ranked = [int(i) for i in indices[0] if i >= 0]
    vector_scores = {int(indices[0][j]): float(distances[0][j]) for j in range(len(indices[0])) if indices[0][j] >= 0}

    # Merge with RRF
    merged = _rrf_merge(bm25_ranked[:TOP_K_RETRIEVE], vector_ranked)
    top_indices = [idx for idx, _ in merged[:TOP_K_RETRIEVE]]

    candidates = []
    for idx in top_indices:
        if idx < len(skills):
            skill = dict(skills[idx])
            skill["_hybrid_score"] = dict(merged).get(idx, 0)
            skill["_vector_score"] = vector_scores.get(idx, 0.0)
            candidates.append(skill)

    if not candidates:
        conn.close()
        return None

    # Normalize scores
    if use_rerank and NEBIUS_API_KEY:
        try:
            from openai import OpenAI
            nano_client = OpenAI(base_url=NEBIUS_API_BASE, api_key=NEBIUS_API_KEY)
            ranked = _nano_rerank(intent, candidates, nano_client)
            candidates = [c for c, _ in sorted(ranked, key=lambda x: x[1], reverse=True)]
            scores = {c["id"]: s for c, s in ranked}
        except Exception:
            # Fallback: use vector cosine similarity
            scores = {c["id"]: c.get("_vector_score", 0.0) for c in candidates}
    else:
        # Use vector cosine similarity as confidence (absolute, not normalized)
        scores = {c["id"]: c.get("_vector_score", 0.0) for c in candidates}

    if not candidates:
        conn.close()
        return None

    best = candidates[0]
    confidence = scores.get(best["id"], 0.5)

    if confidence < CONFIDENCE_THRESHOLD:
        conn.close()
        return None

    # Get full body from DB
    skill_record = None
    for s in skills:
        if s["id"] == best["id"]:
            skill_record = s
            break

    conn.close()

    if skill_record is None:
        return None

    return {
        "name": skill_record["name"],
        "description": skill_record.get("description", ""),
        "content": skill_record["body"],
        "confidence": round(confidence, 4),
    }


def search_debug(intent, top_n=5):
    """Debug search: return top N results with scores."""
    index, conn = load_index()
    if index is None or conn is None:
        return []

    skills = get_all_skills(conn)
    if not skills:
        conn.close()
        return []

    # Filter disabled skills
    skills = [s for s in skills if s.get("enabled", True)]

    bm25 = _build_bm25(skills)
    bm25_scores = bm25.get_scores(_tokenize(intent))
    bm25_ranked = sorted(range(len(skills)), key=lambda i: bm25_scores[i], reverse=True)

    model = get_embed_model()
    intent_vec = model.encode([intent], normalize_embeddings=True).astype("float32")
    distances, indices = index.search(intent_vec, min(TOP_K_RETRIEVE, len(skills)))
    vector_ranked = [int(i) for i in indices[0] if i >= 0]

    merged = _rrf_merge(bm25_ranked[:TOP_K_RETRIEVE], vector_ranked)

    results = []
    for idx, score in merged[:top_n]:
        if idx < len(skills):
            s = skills[idx]
            results.append({
                "name": s["name"],
                "description": s["description"],
                "score": round(score, 4),
            })

    conn.close()
    return results