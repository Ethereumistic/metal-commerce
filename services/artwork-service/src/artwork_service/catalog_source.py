"""Safe fetching of a product's first catalog image.

Only HTTPS URLs on allowlisted catalog media hosts (and their path prefixes)
are fetched. Every redirect hop is re-validated, and every hop's host is
resolved and checked so that no request reaches a private, loopback,
link-local, metadata or otherwise non-public address. The connection is made to
the vetted IP itself (with the original host for SNI and certificate checks), so
a DNS answer cannot change between the check and the request. Size, pixel and
time limits are enforced while streaming, and the format is sniffed from the
bytes rather than trusted from headers.
"""

from __future__ import annotations

import hashlib
import io
import ipaddress
import re
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol
from urllib.parse import urljoin, urlsplit

import httpx
from PIL import Image

from .config import Config
from .errors import ServiceError

USER_AGENT = "metal-craft-artwork-service/1"

Resolver = Callable[[str, int], list[str]]


@dataclass(frozen=True)
class FetchedSource:
    data: bytes
    sha256: str
    format: str
    width: int
    height: int


class SourceFetcher(Protocol):
    def fetch(self, url: str) -> FetchedSource: ...


def sniff_format(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if data.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def inspect_image(data: bytes, max_pixels: int) -> FetchedSource:
    """Validate sniffed format and header dimensions without decoding pixels."""
    fmt = sniff_format(data)
    if fmt is None:
        raise ServiceError("UNSUPPORTED_FORMAT", "The first image is not a PNG, JPEG or WebP file.",
                           {"magic": data[:12].hex()})
    try:
        with Image.open(io.BytesIO(data)) as img:
            width, height = img.size
    except Exception as exc:  # Pillow raises many types for corrupt headers
        raise ServiceError("UNSUPPORTED_FORMAT", "The first image could not be read; it may be corrupt.",
                           {"reason": type(exc).__name__}) from exc
    if width * height > max_pixels:
        raise ServiceError("SOURCE_TOO_LARGE",
                           f"The first image is {width}×{height} px, above the {max_pixels} pixel limit.",
                           {"width": width, "height": height, "max_pixels": max_pixels})
    return FetchedSource(data=data, sha256=hashlib.sha256(data).hexdigest(), format=fmt,
                         width=width, height=height)


def is_public_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
                or ip.is_reserved or ip.is_unspecified or not ip.is_global)


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({info[4][0] for info in infos})


def safe_url_for_log(url: str) -> str:
    """URL without query or fragment (signed media URLs carry credentials there)."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.hostname or ''}{parts.path}"


class HttpSourceFetcher:
    def __init__(self, config: Config, *, resolver: Resolver = system_resolver,
                 transport: httpx.BaseTransport | None = None) -> None:
        self.allowed = config.allowed_sources
        self.max_bytes = config.fetch_max_bytes
        self.timeout_s = config.fetch_timeout_s
        self.max_redirects = config.fetch_max_redirects
        self.max_pixels = config.max_source_pixels
        self.resolver = resolver
        self.transport = transport

    def check_url(self, url: str) -> tuple[str, str]:
        """Validate scheme, host allowlist, port and path; returns (host, vetted ip)."""
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError as exc:
            raise ServiceError("SOURCE_HOST_NOT_ALLOWED", "The image URL is malformed.", {}) from exc
        host = (parts.hostname or "").lower()
        if parts.scheme != "https":
            raise ServiceError("SOURCE_HOST_NOT_ALLOWED", "Only HTTPS catalog media URLs can be fetched.",
                               {"scheme": parts.scheme})
        if parts.username or parts.password:
            raise ServiceError("SOURCE_HOST_NOT_ALLOWED", "Image URLs with credentials are not allowed.", {})
        prefix = self.allowed.get(host)
        if prefix is None:
            raise ServiceError("SOURCE_HOST_NOT_ALLOWED", "The image host is not an allowed catalog media host.",
                               {"host": host})
        if port not in (None, 443):
            raise ServiceError("SOURCE_HOST_NOT_ALLOWED", "Catalog media must be served on port 443.",
                               {"port": port})
        if not parts.path.startswith(prefix) or "/../" in parts.path or parts.path.endswith("/.."):
            raise ServiceError("SOURCE_HOST_NOT_ALLOWED", "The image path is not an allowed catalog media path.",
                               {"host": host, "path_prefix": prefix})
        try:
            addresses = self.resolver(host, 443)
        except OSError as exc:
            raise ServiceError("SOURCE_UNAVAILABLE", "The image host could not be resolved.",
                               {"host": host}) from exc
        if not addresses:
            raise ServiceError("SOURCE_UNAVAILABLE", "The image host did not resolve.", {"host": host})
        bad = [a for a in addresses if not is_public_ip(a)]
        if bad:
            raise ServiceError("SOURCE_HOST_NOT_ALLOWED", "The image host resolves to a non-public address.",
                               {"host": host})
        return host, addresses[0]

    def fetch(self, url: str) -> FetchedSource:
        deadline = time.monotonic() + self.timeout_s
        current = url
        with httpx.Client(transport=self.transport, follow_redirects=False, trust_env=False,
                          timeout=httpx.Timeout(self.timeout_s)) as client:
            for _hop in range(self.max_redirects + 1):
                host, ip = self.check_url(current)
                response = self._request(client, current, host, ip, deadline)
                if isinstance(response, str):
                    current = response
                    continue
                return inspect_image(response, self.max_pixels)
        raise ServiceError("SOURCE_UNAVAILABLE", "The image URL redirected too many times.",
                           {"max_redirects": self.max_redirects})

    def _request(self, client: httpx.Client, url: str, host: str, ip: str,
                 deadline: float) -> bytes | str:
        parts = urlsplit(url)
        ip_host = f"[{ip}]" if ":" in ip else ip
        target = parts._replace(netloc=ip_host).geturl()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ServiceError("TIMEOUT", "Fetching the image took too long.", {"timeout_s": self.timeout_s})
        try:
            with client.stream("GET", target, headers={"Host": host, "User-Agent": USER_AGENT,
                                                       "Accept": "image/png,image/jpeg,image/webp"},
                               extensions={"sni_hostname": host,
                                           "timeout": {"connect": remaining, "read": remaining,
                                                       "write": remaining, "pool": remaining}}) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location")
                    if not location:
                        raise ServiceError("SOURCE_UNAVAILABLE", "The image host sent a redirect without a target.",
                                           {"status": resp.status_code})
                    return urljoin(url, location)
                if resp.status_code != 200:
                    raise ServiceError("SOURCE_UNAVAILABLE",
                                       f"The image host answered HTTP {resp.status_code}.",
                                       {"status": resp.status_code, "url": safe_url_for_log(url)})
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > self.max_bytes:
                    raise ServiceError("SOURCE_TOO_LARGE", "The image file is larger than the allowed size.",
                                       {"bytes": int(declared), "max_bytes": self.max_bytes})
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_bytes():
                    total += len(chunk)
                    if total > self.max_bytes:
                        raise ServiceError("SOURCE_TOO_LARGE", "The image file is larger than the allowed size.",
                                           {"max_bytes": self.max_bytes})
                    if time.monotonic() > deadline:
                        raise ServiceError("TIMEOUT", "Fetching the image took too long.",
                                           {"timeout_s": self.timeout_s})
                    chunks.append(chunk)
                return b"".join(chunks)
        except httpx.TimeoutException as exc:
            raise ServiceError("TIMEOUT", "Fetching the image took too long.",
                               {"timeout_s": self.timeout_s}) from exc
        except httpx.HTTPError as exc:
            raise ServiceError("SOURCE_UNAVAILABLE", "The image could not be downloaded.",
                               {"reason": type(exc).__name__, "url": safe_url_for_log(url)}) from exc


TEST_FIXTURE_PREFIX = "test-fixture://local/"
_FIXTURE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")


class FixtureDirFetcher:
    """Acceptance-test source: serves `test-fixture://local/<name>` from one directory.

    Only built when `ARTWORK_TEST_FIXTURE_DIR` is set; every other URL goes to
    the normal HTTPS fetcher. Names are plain file names (no separators), so a
    URL cannot reach outside the directory.
    """

    def __init__(self, directory: Path, fallback: SourceFetcher, max_pixels: int) -> None:
        self.directory = directory.resolve()
        self.fallback = fallback
        self.max_pixels = max_pixels

    def fetch(self, url: str) -> FetchedSource:
        if not url.startswith(TEST_FIXTURE_PREFIX):
            return self.fallback.fetch(url)
        name = url[len(TEST_FIXTURE_PREFIX):]
        if not _FIXTURE_NAME.match(name) or ".." in name:
            raise ServiceError("SOURCE_HOST_NOT_ALLOWED", "The test fixture name is invalid.", {})
        path = self.directory / name
        if not path.is_file():
            raise ServiceError("SOURCE_UNAVAILABLE", "The test fixture does not exist.", {"name": name})
        return inspect_image(path.read_bytes(), self.max_pixels)


def build_fetcher(config: Config) -> SourceFetcher:
    """The production fetcher, wrapped with the test fixture source only when configured."""
    http = HttpSourceFetcher(config)
    if config.test_fixture_dir is None:
        return http
    return FixtureDirFetcher(config.test_fixture_dir, http, config.max_source_pixels)
