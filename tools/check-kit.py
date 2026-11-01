#!/usr/bin/env python3
"""Verify this site's vendored copy of the Libre Computer shell kit.

css/lc-kit.css and js/lc-kit.js are VENDORED: they are written by
tools/lc-ui-kit/sync.py in the internal tooling repo and are not edited here.
Vendoring's failure mode is a well-meant local fix that then disappears the
next time the kit is synced, or -- worse -- survives and silently makes this
site's shell different from its sibling's. So each copy carries a checksum of
its own body in its first line, and this recomputes it.

That is the half of the question CI can answer without the canonical: has
anyone hand-edited the vendored files? A real divergence from the canonical is
caught by running sync.py --check where both are available.

The pre-paint theme snippet is checked too. It cannot live in the module -- it
has to run before first paint and a module is deferred -- so it is inline in
every page, and inline copies are exactly the thing that drifts. Without it a
dark visitor gets a white flash on every load.

And data/lc-products.json, where a site has it: the board links beside the
board picker may only name boards this site lists unhidden, and link only to
https://libre.computer and https://cad.place.

And every page that uses the kit carries a Content-Security-Policy <meta>
ahead of its scripts, allowing exactly its inline scripts by sha256.

    tools/check-kit.py          exit 0 clean, 1 with findings
"""

import base64
import hashlib
import html as html_mod
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
FILES = ["css/lc-kit.css", "js/lc-kit.js"]
BANNER = re.compile(r"^/\* lc-kit (\S+) sha256:([0-9a-f]{64}) \*/\n")


# data/lc-products.json (written by sync.py) puts links on the page, beside
# the board picker. A link there can only go to the board's page on
# libre.computer or its model in cad.place, over https, and only for a board
# this site lists and does not hide.
PRODUCTS = "data/lc-products.json"
LINK_HOSTS = {"page": "libre.computer", "model": "cad.place"}


def check_products(problems):
    path = ROOT / PRODUCTS
    if not path.exists():
        return
    try:
        boards = json.loads(path.read_text())["boards"]
        listed = {b["id"] for b in json.loads((ROOT / "data/boards.json").read_text())["boards"]
                  if not b.get("hidden")}
    except (OSError, ValueError, KeyError, TypeError) as e:
        problems.append(f"{PRODUCTS}: unreadable ({e})")
        return
    if not isinstance(boards, dict):
        problems.append(f"{PRODUCTS}: boards is not an object")
        return
    for bid, b in boards.items():
        if bid not in listed:
            problems.append(f"{PRODUCTS}: {bid!r} is not a board this site lists (unhidden)")
        if not isinstance(b, dict) or not isinstance(b.get("name"), str) or "page" not in b:
            problems.append(f"{PRODUCTS}[{bid}]: needs a name and a page")
            continue
        for key, host in LINK_HOSTS.items():
            if key not in b:
                continue
            u = urlsplit(b[key]) if isinstance(b[key], str) else None
            if not u or u.scheme != "https" or u.hostname != host:
                problems.append(f"{PRODUCTS}[{bid}].{key}: {b[key]!r} is not https://{host}/...")


# Every page carries a Content-Security-Policy <meta> (the sites are static
# files; their hosts set no headers we control), allowing each inline script
# -- the theme snippet above all -- by its sha256 and nothing more. A kit
# re-sync that changes the snippet fails here until the page's hash follows.
#
# The check does not try to parse HTML as a browser would (round 10 found a
# pattern-matcher can be talked round: a meta inside <title>, a stray <div>
# closing <head>, a "<!-->" comment). It accepts ONE shape instead: the page
# opens with the doctype, <html>, <head>, the charset meta, at most one plain
# comment, then the policy meta in exactly this form -- nothing a browser
# could read differently. Anything else is refused, not interpreted.
# (HTML whitespace only: Python's \s also matches \x0b, \xa0, U+2028 ...,
# any of which closes <head> in a browser and drops the policy into <body>)
_WS = r"[\t\n\f\r ]*"
CANONICAL_HEAD = re.compile(
    rf'<!DOCTYPE html>{_WS}<html(?: lang="[a-z-]+")?>{_WS}<head>{_WS}<meta charset="utf-8">{_WS}'
    rf"(?:<!--(?!-?>)(?:(?!--!?>)[^<])*-->{_WS})?"   # one plain comment, no "<", no "<!-->" / "--!>"
    r'<meta http-equiv="Content-Security-Policy" content="([^"<>]*)">')
# Documents a browser runs script in, by how the servers (GitHub Pages,
# nginx) type them:
#   - HTML pages are checked against the fixed head shape above;
#   - SVG and XML opened directly run with no policy, so each must parse as
#     a plain drawing or a sitemap (check_xml: listed elements and
#     attributes only);
#   - the site root carries .nojekyll: without it GitHub Pages runs Jekyll,
#     which renders every .md into a page with no policy and passes raw HTML
#     through.
#
# Every file in the tree must have a suffix on the list below -- what these
# sites publish, each checked for how GitHub Pages and nginx serve it -- so a
# type a server would render as a document (.xhtml, .svgz, .xsd, ...) is
# refused for being unknown, not missed for being unlisted. Text files must
# be strict UTF-8 with no byte-order mark: a UTF-16 file decoded here as
# UTF-8 hides every word a browser, following its BOM, would read.
PAGE_SUFFIXES = {".html", ".htm", ".shtml"}
XML_SUFFIXES = {".svg", ".xml"}
TEXT_SUFFIXES = PAGE_SUFFIXES | XML_SUFFIXES | {
    ".css", ".js", ".mjs", ".json", ".map", ".md", ".txt", ".py", ".yml", ".yaml"}
BINARY_SUFFIXES = {".ico", ".webp", ".png", ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".pyc"}
NAMES = {"CNAME", ".gitignore", ".nojekyll", ".public-surface-allow"}  # (no suffix)
# XML documents (round 14: a deny-list missed an XHTML <iframe srcdoc>):
# parsed, and every element and attribute must be on these lists -- the
# drawing subset of SVG our diagrams use, and a sitemap. Nothing else.
SVG_NS = "{http://www.w3.org/2000/svg}"
SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
XML_ELEMENTS = {SVG_NS + t for t in (
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "title", "desc", "defs", "marker", "linearGradient", "radialGradient", "stop")} | {
    SITEMAP_NS + t for t in ("urlset", "url", "loc", "lastmod", "changefreq", "priority")}
XML_ATTRS = {
    "aria-label", "role", "id", "class", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
    "cx", "cy", "r", "rx", "ry", "dx", "dy", "d", "points", "transform", "fill", "fill-opacity",
    "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity",
    "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline",
    "letter-spacing", "marker-end", "marker-start", "markerHeight", "markerWidth", "orient",
    "refX", "refY", "offset", "stop-color", "stop-opacity"}
# a value may name a local reference only (url(#id)), never a scheme
XML_VALUE_BAD = re.compile(r"url\((?!#[\w-]+\))|[a-z][a-z0-9+.-]*:(?!\s)|&", re.I)


def check_xml(text):
    """The XML document is a plain drawing or a sitemap, or the reason it is not."""
    m = re.search(r"<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<!\[CDATA\[", text, re.I)
    if m:
        return f"{m.group(0)!r} (no DTD, entity, stylesheet or CDATA in an XML document)"
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        return f"not well-formed XML ({e})"
    for el in root.iter():
        if el.tag not in XML_ELEMENTS:
            return f"element {el.tag!r} is not on the list a published SVG or sitemap may use"
        for name, value in el.attrib.items():
            if name not in XML_ATTRS:
                return f"attribute {name!r} on {el.tag!r} is not on the list"
            if XML_VALUE_BAD.search(value):
                return f"attribute {name}={value!r} names a URL or a scheme"
    return None
# every inline script a browser could run: any attributes, any case, no src=
INLINE_SCRIPT = re.compile(r"<script\b(?![^>]*\ssrc\s*=)[^>]*>(.*?)</script\s*>", re.I | re.S)
SCRIPT_DIRECTIVES = ("script-src", "script-src-elem", "script-src-attr")
SHA = re.compile(r"'sha256-([A-Za-z0-9+/=]+)'")
ASCII_WS = re.compile(r"[\t\n\f\r ]+")   # CSP splits on ASCII whitespace only


def check_csp(html):
    m = CANONICAL_HEAD.match(html)
    if not m:
        return ["the page does not open with <!DOCTYPE html>, <html>, <head>, the charset "
                "meta, at most one plain comment, then the Content-Security-Policy meta"]
    policy = html_mod.unescape(m.group(1))
    # printable ASCII only: a non-breaking space or a control character would
    # split differently in a browser than here
    if not re.fullmatch(r"[\t\n\f\r\x20-\x7e]*", policy):
        return ["the policy holds a character outside printable ASCII"]
    directives = {}
    for part in policy.split(";"):
        words = [w for w in ASCII_WS.split(part) if w]
        if words:
            directives.setdefault(words[0].lower(), words[1:])
    if "script-src" not in directives:
        return ["the policy has no script-src"]
    allowed, out = set(), []
    for name in SCRIPT_DIRECTIVES:
        for source in directives.get(name, []):
            h = SHA.fullmatch(source)
            if h:
                allowed.add(h.group(1))
            elif source.lower() != "'self'":
                out.append(f"{name} allows {source!r}: only 'self' and 'sha256-…' hashes")
    if out:
        return out
    needed = {base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()
              for s in INLINE_SCRIPT.findall(html)}
    out = [f"an inline script (sha256-{h}) the policy does not allow" for h in sorted(needed - allowed)]
    out += [f"the policy allows sha256-{h}, which no inline script has" for h in sorted(allowed - needed)]
    return out


def main():
    problems = []

    for rel in FILES:
        path = ROOT / rel
        if not path.exists():
            problems.append(f"{rel} is missing")
            continue
        text = path.read_text()
        m = BANNER.match(text)
        if not m:
            problems.append(f"{rel} has no lc-kit banner -- it was not written "
                            f"by sync.py")
            continue
        body = text[m.end():]
        if hashlib.sha256(body.encode("utf-8")).hexdigest() != m.group(2):
            problems.append(
                f"{rel} has been hand-edited: its checksum does not match its "
                f"own contents. Make the change in tools/lc-ui-kit/ in the "
                f"tooling repo and re-run sync.py, or the next sync will "
                f"revert it.")

    # The snippet is read from the kit rather than restated, so this file
    # cannot itself become the stale copy.
    js = (ROOT / "js/lc-kit.js")
    snippet = None
    if js.exists():
        m = re.search(r"export const HEAD_SNIPPET =\n(.*?);\n", js.read_text(), re.S)
        if m:
            snippet = "".join(re.findall(r"`([^`]*)`", m.group(1)))
    if snippet:
        for page in sorted(ROOT.glob("*.html")):
            html = page.read_text()
            if "lc-kit.js" in html and snippet not in html:
                problems.append(
                    f"{page.name} does not carry the current pre-paint theme "
                    f"snippet -- without it a dark visitor sees a white flash "
                    f"on every load.")

    check_products(problems)
    if not (ROOT / ".nojekyll").is_file():
        problems.append(".nojekyll is missing: GitHub Pages would run Jekyll, which renders "
                        "each .md into a page with no Content-Security-Policy")
    # every document in the tree a browser could run script in, kit or not
    # (a generated site keeps its pages in directories, a redirect stub is a
    # page too, and tools/ is served as well); only git's own dir is skipped
    for doc in sorted(p for p in ROOT.rglob("*") if p.is_file() or p.is_symlink()):
        rel = doc.relative_to(ROOT)
        if rel.parts[0] == ".git":
            continue
        if doc.is_symlink():
            problems.append(f"{rel}: a symlink (a server may follow it to anything)")
            continue
        suffix = doc.suffix.lower()
        if doc.name in NAMES or suffix in BINARY_SUFFIXES:
            continue
        if suffix not in TEXT_SUFFIXES:
            problems.append(f"{rel}: {suffix or 'no suffix'} is not a file type these sites "
                            f"publish -- add it to check-kit.py only after checking how GitHub "
                            f"Pages and nginx serve it")
            continue
        raw = doc.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            problems.append(f"{rel}: not UTF-8 (a browser may decode it otherwise than this check)")
            continue
        if text.startswith("﻿") or "\x00" in text:
            problems.append(f"{rel}: a byte-order mark or NUL (a browser may decode it otherwise)")
            continue
        if suffix in PAGE_SUFFIXES:
            problems += [f"{rel}: {p}" for p in check_csp(text)]
        elif suffix in XML_SUFFIXES:
            why = check_xml(text)
            if why:
                problems.append(f"{rel}: {why} -- opened directly an XML document runs with no "
                                f"policy, so it may only be a plain drawing or a sitemap")

    if problems:
        print(f"FAIL  {len(problems)} finding(s):", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    print(f"OK  lc-kit vendored files intact ({', '.join(FILES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
