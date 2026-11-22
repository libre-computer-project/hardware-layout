#!/usr/bin/env python3
"""Check the site before it is published.

Everything in this repository is public the moment it is pushed, and a static
site has no server to catch a mistake at request time -- a board file that does
not parse, an index row pointing at a file nobody generated, or a CAD field
still naming the design house's workstation all reach the visitor exactly as
committed. So the checks run here, and CI refuses the deploy if any fails.

Four questions, in the order in which getting one wrong costs the most:

  1. Does every board the index lists actually have its data files, and does
     every data file belong to a board the index lists? A missing file is a
     board that 404s; an orphan file is a board that is published without ever
     appearing in the picker, which is the disclosure failure, not a tidiness
     one.
  2. Does every file parse, and does each carry the fields the viewer reads?
  3. Does any string in the shipped data name a machine, a person or a path?
  4. Do the pages reference only files that exist?
  5. Do the pages tools/render.mjs writes (one per board, robots.txt,
     sitemap.xml, llms.txt) cover exactly the boards listed by default?

Usage:  tools/check-site.py [--root .]      exit 0 clean, 1 with findings
"""

import argparse
import json
import re
import sys
from pathlib import Path

# Same pattern the generator applies on the way in. It is repeated rather than
# imported because this script has to be able to judge a data directory it did
# not produce -- a hand-edited file, or one from an older generator.
LEAK = re.compile(
    r"""(
        [A-Za-z]:[\\/]
      | \\\\[A-Za-z0-9._-]+\\
      | (?:https?|ftp|file)://
      | [\w.+-]+@[\w-]+\.[\w.-]+
      | /(?:home|Users|mnt|srv|opt)/
    )""",
    re.VERBOSE | re.IGNORECASE,
)

# Hosts the pages are allowed to link out to. A URL in the DATA is a finding
# whatever it points at; a URL in the markup is fine if it is one of ours.
LINK_OK = ("libre.computer", "hardware.libre.computer", "github.com/libre-computer-project")

ORIGIN = "https://layout.hardware.libre.computer"
ROBOTS = f"User-agent: *\nAllow: /\n\nSitemap: {ORIGIN}/sitemap.xml\n"

BASE_KEYS = {"id", "model", "name", "soc", "outline", "categories", "components",
             "nets", "pin_nets", "copper_index"}
INDEX_KEYS = {"id", "model", "name", "soc", "vendor", "status", "hidden"}
STATUSES = {"production", "unreleased", "preprod", "reference"}


def walk_strings(node, path, out):
    if isinstance(node, str):
        out.append((path, node))
    elif isinstance(node, dict):
        for k, v in node.items():
            out.append((path + ".<key>", k))
            walk_strings(v, f"{path}.{k}", out)
    elif isinstance(node, list):
        # Coordinate arrays are the bulk of every file and hold no strings but
        # the path commands, so this stays cheap in practice.
        for i, v in enumerate(node):
            if isinstance(v, (str, dict, list)):
                walk_strings(v, f"{path}[{i}]", out)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = ap.parse_args()
    root = args.root
    data = root / "data"
    bad = []

    index_path = data / "boards.json"
    if not index_path.exists():
        print(f"FAIL  {index_path} is missing", file=sys.stderr)
        return 1
    index = json.loads(index_path.read_text())["boards"]

    ids = [b["id"] for b in index]
    if len(ids) != len(set(ids)):
        bad.append("boards.json: duplicate board id")

    # 1 + 2 -- the index and the files agree, and the files are readable.
    # (lc-products.json: the board links beside the picker, written by the
    # kit's sync and checked by tools/check-kit.py)
    expected = {"boards.json", "lc-products.json"}
    for row in index:
        missing = INDEX_KEYS - set(row)
        if missing:
            bad.append(f"boards.json[{row.get('id','?')}]: missing {sorted(missing)}")
        if row.get("status") not in STATUSES:
            bad.append(f"boards.json[{row['id']}]: unknown status {row.get('status')!r}")
        if row.get("shares_layout_with") and row["shares_layout_with"] not in ids:
            bad.append(f"boards.json[{row['id']}]: shares_layout_with names an "
                       f"unknown board {row['shares_layout_with']!r}")

        base = data / f"{row['id']}.json"
        expected.add(base.name)
        if not base.exists():
            bad.append(f"{row['id']}: data/{base.name} is missing")
            continue
        try:
            b = json.loads(base.read_text())
        except json.JSONDecodeError as e:
            bad.append(f"{base.name}: does not parse -- {e}")
            continue
        miss = BASE_KEYS - set(b)
        if miss:
            bad.append(f"{base.name}: missing {sorted(miss)}")
        if not b.get("components", {}).get("top"):
            bad.append(f"{base.name}: no top-side components")

        if b.get("copper_file"):
            cu = data / b["copper_file"]
            expected.add(cu.name)
            if not cu.exists():
                bad.append(f"{row['id']}: copper_file names a missing data/{cu.name}")
            else:
                try:
                    layers = json.loads(cu.read_text())
                except json.JSONDecodeError as e:
                    bad.append(f"{cu.name}: does not parse -- {e}")
                    layers = []
                if len(layers) != len(b.get("copper_index", [])):
                    bad.append(f"{row['id']}: copper_index lists "
                               f"{len(b['copper_index'])} layers, "
                               f"{cu.name} carries {len(layers)}")
        elif b.get("copper_index"):
            bad.append(f"{base.name}: copper_index is non-empty but no copper_file")

        # 3 -- nothing in the shipped data may name a machine.
        strings = []
        walk_strings({k: v for k, v in b.items() if k != "components"}, row["id"], strings)
        for comp in b.get("components", {}).values():
            for c in comp:
                if c.get("prop"):
                    walk_strings(c["prop"], f"{row['id']}.{c['r']}.prop", strings)
        for where, s in strings:
            if LEAK.search(s):
                bad.append(f"{where}: value names a path or host -- {s!r}")

    # 1 (the other direction) -- a data file nobody indexes is published silently.
    for f in sorted(data.glob("*.json")):
        if f.name not in expected:
            bad.append(f"data/{f.name}: not referenced by boards.json -- either "
                       f"add the board to the index or delete the file")

    # 4 -- the markup's own references resolve (a board's page, one level
    # down, from its own directory).
    pages = sorted(root.glob("*.html")) + sorted(root.glob("*/index.html"))
    for page in pages:
        html = page.read_text()
        name = page.relative_to(root).as_posix()
        for ref in re.findall(r'(?:src|href)="([^"#?]+)"', html):
            if ref.startswith(("http://", "https://", "data:", "mailto:", "//")):
                if ref.startswith(("http://", "https://")) and \
                        not any(h in ref for h in LINK_OK):
                    bad.append(f"{name}: links off-site to {ref}")
                continue
            target = root / ref.lstrip("/") if ref.startswith("/") else page.parent / ref
            if not target.exists():
                bad.append(f"{name}: references missing {ref}")

    # 5 -- what tools/render.mjs writes agrees with the index: a page, and a
    # sitemap and llms.txt entry, for every board listed by default and for
    # nothing else. A page for a hidden board would publish, to every crawler,
    # a board the picker shows only under the switch.
    hidden_ids = [b["id"] for b in index if b["hidden"]]
    listed_ids = [b["id"] for b in index if not b["hidden"]]
    word = lambda i: re.compile(rf"(?<![\w-]){re.escape(i)}(?![\w-])")
    for d in sorted(p for p in root.iterdir() if p.is_dir() and (p / "index.html").exists()):
        if d.name not in listed_ids:
            bad.append(f"{d.name}/index.html: a page for a board not listed by default "
                       f"-- re-run node tools/render.mjs")
    for i in listed_ids:
        page = root / i / "index.html"
        if not page.exists():
            bad.append(f"{i}: no {i}/index.html -- run node tools/render.mjs and commit it")
            continue
        html = page.read_text()
        if f'<body data-board="{i}">' not in html:
            bad.append(f"{i}/index.html: its <body> does not carry data-board=\"{i}\"")
        if f'<link rel="canonical" href="{ORIGIN}/{i}/">' not in html:
            bad.append(f"{i}/index.html: no canonical {ORIGIN}/{i}/")
        if '<div id="parts-text"><details' not in html:
            bad.append(f"{i}/index.html: no parts list in #parts-text")
    home = (root / "index.html").read_text() if (root / "index.html").exists() else ""
    if f'<link rel="canonical" href="{ORIGIN}/">' not in home:
        bad.append(f"index.html: no canonical {ORIGIN}/")
    robots = root / "robots.txt"
    if not robots.exists() or robots.read_text() != ROBOTS:
        bad.append("robots.txt: missing or not the standard text -- run node tools/render.mjs")
    sm = root / "sitemap.xml"
    if sm.exists():
        locs = re.findall(r"<loc>([^<]*)</loc>", sm.read_text())
        want = [f"{ORIGIN}/"] + [f"{ORIGIN}/{i}/" for i in listed_ids]
        if locs != want:
            bad.append("sitemap.xml: does not list exactly the home page and every listed "
                       "board's page -- run node tools/render.mjs")
    else:
        bad.append("sitemap.xml is missing -- run node tools/render.mjs")
    if not (root / "llms.txt").exists():
        bad.append("llms.txt is missing -- run node tools/render.mjs")
    for f in [root / "sitemap.xml", root / "llms.txt", *pages]:
        if not f.exists():
            continue
        text = f.read_text()
        for i in hidden_ids:
            if word(i).search(text):
                bad.append(f"{f.relative_to(root).as_posix()}: names a board hidden by default")

    listed = sum(1 for b in index if not b["hidden"])
    if bad:
        print(f"FAIL  {len(bad)} finding(s):", file=sys.stderr)
        for b in bad:
            print("  " + b, file=sys.stderr)
        return 1

    # This line lands in the public Actions log, so it counts the unlisted
    # boards without naming the switch that reveals them.
    print(f"OK  {len(index)} boards ({listed} listed, {len(index) - listed} "
          f"unlisted), every data file indexed, no path-like values, "
          f"{len(listed_ids)} board pages and the sitemap match the listed boards")
    return 0


if __name__ == "__main__":
    sys.exit(main())
