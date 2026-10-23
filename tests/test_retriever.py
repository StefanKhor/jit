"""Tests for JIT retriever."""

import pytest

from jit.retriever import _tokenize, _rrf_merge


def test_tokenize():
    assert _tokenize("Hello World") == ["hello", "world"]
    assert _tokenize("create a Linear issue") == ["create", "a", "linear", "issue"]


def test_rrf_merge():
    result = _rrf_merge([0, 1, 2], [2, 0, 3])
    assert isinstance(result, list)
    assert len(result) > 0
    # Index 0 and 2 appear in both lists, should rank high
    indices = [idx for idx, _ in result]
    assert 0 in indices
    assert 2 in indices