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

    tools/check-kit.py          exit 0 clean, 1 with findings
"""

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["css/lc-kit.css", "js/lc-kit.js"]
BANNER = re.compile(r"^/\* lc-kit (\S+) sha256:([0-9a-f]{64}) \*/\n")


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

    if problems:
        print(f"FAIL  {len(problems)} finding(s):", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    print(f"OK  lc-kit vendored files intact ({', '.join(FILES)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
