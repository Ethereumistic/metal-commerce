"""SSRF protections and limits of the catalog image fetcher (no network: mocked transport/resolver)."""

from __future__ import annotations

from dataclasses import replace

import httpx
import pytest

from artwork_service.catalog_source import HttpSourceFetcher, is_public_ip
from artwork_service.errors import ServiceError

from conftest import synthetic

PUBLIC_IP = "93.184.216.34"
PNG = synthetic("ring")


def make(config, handler=None, addresses=None, **overrides):
    cfg = replace(config, **overrides) if overrides else config
    seen: list[httpx.Request] = []

    def default(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=PNG)

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return (handler or default)(request)

    resolver = (lambda host, port: addresses.get(host, [PUBLIC_IP])) if addresses else (lambda host, port: [PUBLIC_IP])
    fetcher = HttpSourceFetcher(cfg, resolver=resolver, transport=httpx.MockTransport(record))
    return fetcher, seen


def code(fn) -> str:
    with pytest.raises(ServiceError) as exc:
        fn()
    return exc.value.code


def test_fetches_allowed_https_media_by_vetted_ip(config) -> None:
    fetcher, seen = make(config)
    src = fetcher.fetch("https://convex.echoray.io/api/storage/abc?sig=1")
    assert src.format == "PNG" and src.width == 500 and len(src.sha256) == 64
    # The request goes to the vetted IP with the original host for Host/SNI.
    assert seen[0].url.host == PUBLIC_IP
    assert seen[0].headers["host"] == "convex.echoray.io"
    assert seen[0].extensions["sni_hostname"] == "convex.echoray.io"
    assert fetcher.fetch("https://cdn.echoray.io/lib/master.png").format == "PNG"


@pytest.mark.parametrize("url", [
    "http://convex.echoray.io/api/storage/abc",            # not https
    "https://evil.example.com/api/storage/abc",            # host not allowlisted
    "https://convex.echoray.io.evil.com/api/storage/abc",  # suffix trick
    "https://convex.echoray.io/admin/secret",              # outside the media path
    "https://convex.echoray.io/api/storage/../admin",      # traversal out of the prefix
    "https://convex.echoray.io:8443/api/storage/abc",      # non-default port
    "https://user:pw@convex.echoray.io/api/storage/abc",   # embedded credentials
    "file:///etc/passwd",
    "https://127.0.0.1/api/storage/abc",
    "https://169.254.169.254/latest/meta-data/",
])
def test_rejects_disallowed_urls(config, url) -> None:
    fetcher, seen = make(config)
    assert code(lambda: fetcher.fetch(url)) == "SOURCE_HOST_NOT_ALLOWED"
    assert seen == []


@pytest.mark.parametrize("address", ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.16.0.9", "169.254.169.254",
                                     "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"])
def test_rejects_hosts_resolving_to_private_addresses(config, address) -> None:
    assert not is_public_ip(address)
    fetcher, seen = make(config, addresses={"convex.echoray.io": [PUBLIC_IP, address]})
    assert code(lambda: fetcher.fetch("https://convex.echoray.io/api/storage/x")) == "SOURCE_HOST_NOT_ALLOWED"
    assert seen == []


def test_every_redirect_hop_is_validated(config) -> None:
    def to_evil(request):
        return httpx.Response(302, headers={"location": "https://evil.example.com/x.png"})

    fetcher, seen = make(config, to_evil)
    assert code(lambda: fetcher.fetch("https://convex.echoray.io/api/storage/x")) == "SOURCE_HOST_NOT_ALLOWED"
    assert len(seen) == 1

    def to_internal(request):
        if request.headers["host"] == "convex.echoray.io":
            return httpx.Response(301, headers={"location": "https://cdn.echoray.io/m.png"})
        return httpx.Response(200, content=PNG)

    fetcher, _ = make(config, to_internal, addresses={"cdn.echoray.io": ["10.0.0.5"]})
    assert code(lambda: fetcher.fetch("https://convex.echoray.io/api/storage/x")) == "SOURCE_HOST_NOT_ALLOWED"

    fetcher, seen = make(config, to_internal)
    assert fetcher.fetch("https://convex.echoray.io/api/storage/x").format == "PNG"
    assert [r.headers["host"] for r in seen] == ["convex.echoray.io", "cdn.echoray.io"]

    def loop(request):
        return httpx.Response(302, headers={"location": "/api/storage/again"})

    fetcher, seen = make(config, loop)
    assert code(lambda: fetcher.fetch("https://convex.echoray.io/api/storage/x")) == "SOURCE_UNAVAILABLE"
    assert len(seen) == config.fetch_max_redirects + 1


def test_size_format_and_status_limits(config) -> None:
    big = make(config, lambda r: httpx.Response(200, headers={"content-length": str(10**9)}, content=b""))[0]
    assert code(lambda: big.fetch("https://convex.echoray.io/api/storage/x")) == "SOURCE_TOO_LARGE"
    streamed = make(config, lambda r: httpx.Response(200, content=PNG), fetch_max_bytes=2048)[0]
    assert code(lambda: streamed.fetch("https://convex.echoray.io/api/storage/x")) == "SOURCE_TOO_LARGE"
    html = make(config, lambda r: httpx.Response(200, content=b"<html>not an image</html>"))[0]
    assert code(lambda: html.fetch("https://convex.echoray.io/api/storage/x")) == "UNSUPPORTED_FORMAT"
    gone = make(config, lambda r: httpx.Response(404))[0]
    assert code(lambda: gone.fetch("https://convex.echoray.io/api/storage/x")) == "SOURCE_UNAVAILABLE"
    pixels = make(config, max_source_pixels=1000)[0]
    assert code(lambda: pixels.fetch("https://convex.echoray.io/api/storage/x")) == "SOURCE_TOO_LARGE"

    def boom(request):
        raise httpx.ConnectTimeout("slow", request=request)

    slow = make(config, boom)[0]
    assert code(lambda: slow.fetch("https://convex.echoray.io/api/storage/x")) == "TIMEOUT"
