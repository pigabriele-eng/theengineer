"""Secure connections to series sites that send an incomplete certificate chain.

adac-motorsport.de sends only its own certificate, not the intermediate one that links it to a trusted root.
Browsers fetch the missing certificate from the address written in the site's certificate ("CA Issuers"); Python
doesn't, so the download fails. This fetches those intermediates once and adds them to the usual trusted roots, so
the site's certificate is still fully checked.
"""
from __future__ import annotations

import ssl
import threading

import certifi
import httpx

_lock = threading.Lock()
_cache: dict[tuple[str, ...], ssl.SSLContext] = {}


def context(issuer_urls: tuple[str, ...]) -> ssl.SSLContext:
    """The trusted roots plus the intermediate certificates at these addresses (DER or PEM)."""
    with _lock:
        if issuer_urls in _cache:
            return _cache[issuer_urls]
        ctx = ssl.create_default_context(cafile=certifi.where())
        for url in issuer_urls:
            data = httpx.get(url, timeout=30, follow_redirects=True).raise_for_status().content
            pem = data.decode() if data.lstrip().startswith(b"-----BEGIN") else ssl.DER_cert_to_PEM_cert(data)
            ctx.load_verify_locations(cadata=pem)
        _cache[issuer_urls] = ctx
        return ctx


def client(issuer_urls: tuple[str, ...]) -> httpx.Client:
    return httpx.Client(verify=context(issuer_urls))
