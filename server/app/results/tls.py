"""Secure connections to series sites that send an incomplete certificate chain.

adac-motorsport.de sends only its own certificate, not the intermediate one that links it to a trusted root.
Browsers fetch the missing certificate from the address written in the site's certificate ("CA Issuers"); Python
doesn't, so the download fails. The intermediates are kept in certs/ (public certificates, nothing secret) and are
added to the usual trusted roots, so the site's certificate is still fully checked against a root we trust.
"""
from __future__ import annotations

import os
import ssl
import threading
from pathlib import Path

import certifi
import httpx

CERTS = Path(__file__).with_name("certs")
_lock = threading.Lock()
_cache: dict[tuple[str, ...], ssl.SSLContext] = {}


def context(names: tuple[str, ...]) -> ssl.SSLContext:
    """The trusted roots plus the intermediate certificates of certs/ with these file names."""
    with _lock:
        if names not in _cache:
            ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or certifi.where())
            for name in names:
                ctx.load_verify_locations(cafile=str(CERTS / name))
            _cache[names] = ctx
        return _cache[names]


def client(names: tuple[str, ...]) -> httpx.Client:
    return httpx.Client(verify=context(names))
