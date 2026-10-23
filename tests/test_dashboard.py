"""Tests for JIT dashboard API."""

import json
import threading
import time
import urllib.request

import pytest

from jit.dashboard import start_dashboard


@pytest.fixture(scope="module")
def dashboard_server():
    t = threading.Thread(target=start_dashboard, kwargs={"port": 8199}, daemon=True)
    t.start()
    time.sleep(2)
    yield "http://127.0.0.1:8199"


def test_health(dashboard_server):
    url = dashboard_server + "/api/health"
    resp = urllib.request.urlopen(url).read()
    data = json.loads(resp)
    assert data["status"] == "healthy"
    assert "version" in data


def test_status(dashboard_server):
    url = dashboard_server + "/api/status"
    resp = urllib.request.urlopen(url).read()
    data = json.loads(resp)
    assert "indexed" in data
    assert "skills" in data
    assert "tools" in data