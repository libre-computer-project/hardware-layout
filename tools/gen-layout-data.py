#!/usr/bin/env python3
"""Build the site's board data from the ODB++ exports.

The input is what `pcb_view.py --json` writes for one board: a single file
carrying the outline, the top and bottom component placements, the netlist and
all eight copper layers. That file is 6-11 MB, and the viewer needs perhaps a
fifth of it to draw the first frame. This turns one of those into the two files
the site actually fetches:

    data/<id>.json          outline, components, categories, nets  -- always
    data/<id>.copper.json   the copper layers                      -- on demand

and rewrites data/boards.json from the manifest below.

The split is the whole point. A visitor who opens a board and never turns on a
copper layer -- which is most of them, the placement view is what the page is
for -- pays for the placement alone, and the copper arrives only if they ask a
layer to appear. Within each file the shrink is arithmetic rather than
selective: separators without spaces, coordinates rounded to the export's own
resolution, and fields dropped when they carry the default. Nothing the
renderer reads is removed, so a board drawn from these files is the same board.

BOARD VISIBILITY. Every board in the manifest ships. `hidden` keeps a board out
of the picker until ?hidden=1 asks for it, exactly as the pinout site does it,
and it is a LISTING control, not access control: the data file is in the repo
and anyone who knows the id can fetch it. A board that must not be public is
removed from the manifest, not marked hidden.

Usage:

    tools/gen-layout-data.py --src <dir-of-pcb_view-json> [--out data] [--board ID]
    tools/gen-layout-data.py --src <dir> --dry-run     # sizes, write nothing
"""

import argparse
import importlib.util
import json
import re
import sys
from datetime import date
from pathlib import Path

# --- the manifest -----------------------------------------------------------
#
# One row per board the site offers. `src` is the file pcb_view.py produced;
# `status` and `hidden` follow the pinout site's vocabulary so a reader moving
# between the two sees one scheme:
#
#   production   sold today                              listed
#   unreleased   production design, not launched          ?hidden=1
#   preprod      V0.X engineering build, never sold       ?hidden=1
#   reference    a silicon vendor's own reference design  ?hidden=1
#
# `reference` is the one class this site has and the pinout site does not: the
# board is not a Libre Computer product at all, and it is here because our own
# design derives from it.

BOARDS = [
    dict(id="aml-s905x-cc-v2", model="AML-S905X-CC-V2", name="Sweet Potato",
         soc="S905X", vendor="Amlogic", status="production", hidden=False,
         rev="V2.0-C", src="AML-S905X-CC-V2.0-C_20230418.json"),
    dict(id="aml-s905x-cc-v3", model="AML-S905X-CC-V3", name="Das Potato",
         soc="S905X", vendor="Amlogic", status="unreleased", hidden=True,
         rev="V3-ICC", src="AML-S905X-CC-V3-ICC_20260104.json"),
    # La Frite has no ODB++ export and is imported from the published PADS
    # mechanical DXF instead, so it carries placement, pads, values and hole
    # geometry but no netlist and no copper routing -- see `layers` in
    # boards.json, which is 0 for this board and 8 for the rest.
    dict(id="aml-s805x-ac", model="AML-S805X-AC", name="La Frite",
         soc="S805X", vendor="Amlogic", status="production", hidden=False,
         rev="V1.0", src="AML-S805X-AC-TOP-190308.json"),
    dict(id="aml-s805x-ac-v2", model="AML-S805X-AC-V2", name="Das Frite",
         soc="S805X", vendor="Amlogic", status="unreleased", hidden=True,
         rev="V2.0C", src="AML-S805X-AC-V2.0C-0803.json"),
    # Alta and Solitude are ONE PCB. Their two ODB++ archives differ (different
    # job names, exported four minutes apart) but every field this site reads
    # out of them is identical: same outline, same 465 nets, same 281 top and
    # 398 bottom parts at the same coordinates, and the SoC footprint is
    # G12A_16X14_3MM_20180105 -- the package A311D (G12B) and S905D3 (SM1)
    # share. So the board views are identical because the boards are, and each
    # page says so rather than leaving a reader to suspect the data.
    dict(id="aml-a311d-cc", model="AML-A311D-CC", name="Alta",
         soc="A311D", vendor="Amlogic", status="production", hidden=False,
         rev="V1.0C", src="AML-A311D-CC-V1.0C_20231028.json",
         shares_layout_with="aml-s905d3-cc"),
    dict(id="aml-a311d-cm", model="AML-A311D-CM", name="Alta CM",
         soc="A311D", vendor="Amlogic", status="preprod", hidden=True,
         rev="V0.2", src="AML-A311D-CM-V0.2.json"),
    dict(id="aml-s905d3-cc", model="AML-S905D3-CC", name="Solitude",
         soc="S905D3", vendor="Amlogic", status="production", hidden=False,
         rev="V1.0C", src="AML-S905D3-CC-V1.0C_20231028.json",
         shares_layout_with="aml-a311d-cc"),
    dict(id="med-mt83-ace", model="MED-MT83-ACE", name="Livia",
         soc="MT8385", vendor="MediaTek", status="preprod", hidden=True,
         rev="V0.1", src="MED-MT83-ACE-V0.1-20251205.json"),
    dict(id="med-mt88-mx", model="MED-MT88-MX", name="Virginia",
         soc="MT8370/MT8390", vendor="MediaTek", status="preprod", hidden=True,
         rev="V0.1", src="MED-G510-V0.1-0805-1.json"),
    dict(id="mtk-g500-mmd", model="G500 MMD", name="MT8385 MMD reference",
         soc="MT8385", vendor="MediaTek", status="reference", hidden=True,
         rev="V1", src="G500_MT8385_MMD_LPDDR4X_eMMC_V1_0928A.json"),
]

# --- disclosure backstop ----------------------------------------------------
#
# pcb_view.py filters CAD provenance out of per-component `properties` at
# export time with an allowlist, so in principle nothing here needs checking.
# In principle is not the standard for a repo that is public the moment it is
# pushed, and the exports on disk may predate any given version of that filter.
# So the same question is asked again, on the way in, against the values this
# script is about to write: anything that looks like a filesystem path, a UNC
# share, a URL or an address fails the build rather than shipping.

LEAK = re.compile(
    r"""(
        [A-Za-z]:[\\/]                 # C:\ or C:/  -- a workstation path
      | \\\\[A-Za-z0-9._-]+\\          # \\server\   -- a UNC share
      | (?:https?|ftp|file)://         # a URL
      | [\w.+-]+@[\w-]+\.[\w.-]+       # an e-mail address
      | /(?:home|Users|mnt|srv|opt)/   # a unix home or mount
    )""",
    re.VERBOSE | re.IGNORECASE,
)


def check_clean(value, where, problems):
    """Record any string under `value` that looks like it names a machine."""
    if isinstance(value, str):
        if LEAK.search(value):
            problems.append(f"{where}: {value!r}")
    elif isinstance(value, dict):
        for k, v in value.items():
            check_clean(k, f"{where}.<key>", problems)
            check_clean(v, f"{where}.{k}", problems)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            check_clean(v, f"{where}[{i}]", problems)


# --- shrink -----------------------------------------------------------------

def q(v, nd=3):
    """Round to the export's own resolution and drop a trailing .0.

    The ODB++ exports carry micron-resolution millimetres, so three decimals is
    the data and a fourth is float noise from the unit conversion. json writes
    17 significant digits for a value like 44.47600000000001, which is 15 bytes
    of nothing -- across ~400k coordinates per board that alone is most of the
    difference between the input file and the output one.
    """
    if not isinstance(v, (int, float)):
        return v
    r = round(float(v), nd)
    i = int(r)
    return i if r == i else r


def qlist(seq, nd=3):
    return [q(v, nd) for v in seq]


def dedupe_path(segs):
    """Drop segments a footprint's silkscreen repeats verbatim.

    Several footprint libraries emit each silk outline twice -- once as the
    part body and once as the assembly drawing on top of it -- and the exporter
    passes both through. They are the same strokes at the same coordinates, so
    the second copy costs bytes and draws nothing the first did not. Order is
    preserved because an arc's sweep is defined against the segment before it.
    """
    seen = set()
    out = []
    for s in segs:
        key = tuple(s)
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


GPIO_HEADER_PINS = 40


def _pinout_primary_class(pinout_dir):
    """The pinout generator's own primary_class, imported rather than copied.

    A pin's DRAWN colour is not its `cls`. A muxable pad can be reached by half
    a dozen peripherals and `cls` names one of them, while the board paints the
    header's I2C pins yellow and its SPI block blue and leaves every other
    muxable pad a green GPIO. Colouring by `cls` disagreed with the pinout on
    20 of AML-A311D-CC's 40 pins.

    The rule is four lines and the temptation is to restate it here. That would
    be a second answer to the question "what colour is this pin", and the two
    would part company the first time either moved. The pinout's generator is
    where it lives, so this imports it -- the module is stdlib plus a sibling,
    with its entry point behind __main__, so importing runs nothing.

    Returns None when the pinout repo is not beside this one, in which case the
    published `primary` field is used if present and the header is left brass
    if not. A wrong colour is worse than no colour.
    """
    tools = Path(pinout_dir).resolve().parent / "tools"
    src = tools / "gen-pinout-data.py"
    if not src.exists():
        return None
    sys.path.insert(0, str(tools))
    try:
        spec = importlib.util.spec_from_file_location("lc_gen_pinout", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.primary_class
    except Exception as exc:                      # noqa: BLE001
        print(f"note: no pin colours -- cannot import {src}: {exc}",
              file=sys.stderr)
        return None
    finally:
        sys.path.remove(str(tools))


UART_FUNC = re.compile(r"UART.*?_(TX|RX)|^(TX|RX)D?$", re.IGNORECASE)


def _uart_wire(pin):
    """Which console-cable wire this pin is, or None.

    The serial header is colour-coded as the CABLE -- ground black, TX white,
    RX green -- so a pin has to be identified by FUNCTION, never by position.
    The order is not a convention that holds: the Amlogic CC boards run
    GND/TX/RX down 2J1 and ROC-RK3399-PC runs RX/TX/GND down J13, so counting
    pads off would put ground at the wrong end of that board's header.
    """
    if (pin.get("cls") == "gnd") or (pin.get("type") == "GND"):
        return "wire-gnd"
    for f in list(pin.get("funcs") or []) + [pin.get("ref") or ""]:
        m = UART_FUNC.search(str(f))
        if m:
            return "wire-tx" if (m.group(1) or m.group(2)).upper() == "TX" else "wire-rx"
    return None


def read_uart_header(data):
    """The dedicated serial-console header, as {id: {pin: wire-class}}.

    A header qualifies only if it is exactly ground, TX and RX -- which is what
    the console cable plugs onto. Identified by what its pins DO, because a
    three-pin header is not otherwise a serial port: AML-S905X-CC's 9J1 is
    GND/SPDIF/5V and ROC-RK3328-CC's J21 and J22 are ADC and PHY pins, and all
    three would be caught by a size test.

    Not the UART pins on the 40-pin header. Those are muxable pads that the
    pinout draws green like any other GPIO, and this is about the header a
    cable goes onto.
    """
    for h in data.get("headers", []):
        pins = h.get("pins") or []
        if len(pins) != 3 or not h.get("id"):
            continue
        wires = {str(p["pin"]): _uart_wire(p) for p in pins
                 if p.get("pin") is not None}
        if set(wires.values()) == {"wire-gnd", "wire-tx", "wire-rx"}:
            return {h["id"]: wires}
    return {}


def read_uart_classes(pinout_dir, board_id):
    """read_uart_header for one board, or {} when it has no published pinout."""
    path = Path(pinout_dir) / f"{board_id}.json"
    if not path.exists():
        return {}
    return read_uart_header(json.loads(path.read_bytes()))


def read_pin_classes(pinout_dir, board_id, primary_class=None):
    """Signal class per pin of the 40-pin GPIO header, from the pinout site.

    {"1": "power3v3", "3": "i2c", ...}

    The classifier is NOT reproduced here. It lives in the pinout site's
    generator, which reads libretech-wiring-tool and the kernel's own pinmux
    tables to decide a pin is i2c rather than gpio, and a second copy of that
    judgement would be a second answer the first time either side changed. This
    reads its OUTPUT, so the two sites cannot disagree about a pin's colour.

    MATCHED BY SIZE, NOT BY NAME, and only for this one header. The two sites
    do not agree on what the header is CALLED: AML-A311D-CC and AML-S905D3-CC
    carry it as 7J2 -- their CAD has no 7J1 at all -- while the pinout
    documents it as 7J1. The 40-pin header is unambiguous by size (each board
    has exactly one connector with 40 pads, and each pinout exactly one header
    with 40 pins), so that is what is matched.

    The smaller headers are deliberately NOT matched. Their names collide
    without meaning the same part -- AML-S905X-CC-V2 has a 2J3 of 8 pins in the
    pinout against a 7-pad 2J3 on the board, and a 9J1 of 3 against a 19-pad
    9J1 -- so a name match there would colour pads of a connector that is not
    the one documented. Sizing them needs the naming settled first.

    Missing is not an error: four of the ten boards have no published pinout
    (the compute module and the three MediaTek boards) and simply keep brass.
    """
    path = Path(pinout_dir) / f"{board_id}.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_bytes())
    sized = [h for h in data.get("headers", [])
             if len(h.get("pins", [])) == GPIO_HEADER_PINS]
    if len(sized) != 1:
        return {}
    out = {}
    for p in sized[0]["pins"]:
        if p.get("pin") is None:
            continue
        # `primary` once the pinout publishes it; until then, its generator's
        # own function applied to the same inputs. Never `cls` -- that is a
        # different question's answer.
        cls = p.get("primary")
        if not cls and primary_class:
            cls = primary_class(p.get("type"), p.get("cls"), p.get("funcs") or [])
        if cls:
            out[str(p["pin"])] = cls
    return out


def pack_component(c, problems, where, pinclasses=None, uartclasses=None):
    """One placed part, with the defaults left out.

    Every key the renderer reads survives. What goes is `origin` when it is the
    same point as `center` (it nearly always is), and the three fields whose
    value is the default for the overwhelming majority of parts -- a null
    height, an unmirrored part, a part that is not major. The reader supplies
    those defaults, so absence and presence-of-default mean the same thing.
    """
    out = {
        "r": c["refdes"],
        "f": c.get("footprint", ""),
        "c": c.get("category", "other"),
        "x": q(c["center"]["x"]),
        "y": q(c["center"]["y"]),
        "w": q(c["size"]["w"]),
        "h": q(c["size"]["h"]),
    }
    if c.get("rotation"):
        out["rot"] = q(c["rotation"], 2)
    if c.get("pin_count"):
        out["p"] = c["pin_count"]
    if c.get("mirror"):
        out["m"] = 1
    if c.get("is_major"):
        out["M"] = 1
    if c.get("height_mm") is not None:
        out["z"] = q(c["height_mm"], 2)
    # A mounting hole's measured bore and annular ring. The viewer draws the
    # ring from `w`/`h` like any other part and the hole from `d`; without `d`
    # it has to invent the bore from a fraction of the outer diameter, which is
    # how every Pi-form-factor board ended up with 0.3 mm holes.
    if c.get("drill_mm"):
        out["d"] = q(c["drill_mm"])
    if c.get("ring_mm"):
        out["ring"] = q(c["ring_mm"])

    org = c.get("origin")
    if org and (q(org["x"]) != out["x"] or q(org["y"]) != out["y"]):
        out["ox"], out["oy"] = q(org["x"]), q(org["y"])

    silk = c.get("silk_outline")
    if silk:
        packed = [[s[0]] + qlist(s[1:]) for s in dedupe_path(silk)]
        out["s"] = packed

    pp = c.get("pin_pads")
    if pp:
        groups = pp.get("groups") if isinstance(pp, dict) and "groups" in pp else [pp]

        # WHICH DOCUMENTED HEADER IS THIS PART, decided once for the whole
        # component rather than per group. A footprint's pads are grouped by
        # SHAPE, and a header's pin 1 is usually a square pad among round ones
        # -- so AML-A311D-CC's 2J1 arrives as a group of two and a group of
        # one, and a rule that measured a group against the pin count matched
        # neither and silently coloured nothing.
        pads = sum(len(g.get("pins") or []) for g in groups)
        wires = (uartclasses or {}).get(c["refdes"])
        colours = None
        if pinclasses and pads == GPIO_HEADER_PINS:
            colours = pinclasses
        elif wires and pads == len(wires):
            colours = wires

        packed_groups = []
        for g in groups:
            pos = g.get("positions") or []
            if not pos:
                continue
            pg = {
                "pw": q(g.get("pad_w", 0)), "ph": q(g.get("pad_h", 0)),
                "sh": g.get("shape", "rect"), "pos": qlist(pos),
            }
            # Keyed by the CAD's own pin designators rather than by counting
            # pads off in order: the order is right on every board here, but
            # that is a property of the export, and a mirrored or bottom-side
            # header would number backwards without saying so.
            if colours:
                cls = [colours.get(str(n), "") for n in (g.get("pins") or [])]
                if any(cls):
                    pg["cls"] = cls
            packed_groups.append(pg)
        if packed_groups:
            out["pp"] = packed_groups

    props = c.get("properties")
    if props:
        check_clean(props, f"{where}.{c['refdes']}.properties", problems)
        out["prop"] = props

    return out


def pack_copper(layer):
    """A copper layer's geometry, rounded. The arrays keep their stride."""
    return {
        "name": layer.get("name", ""),
        "label": layer.get("label", layer.get("name", "")),
        "traces": qlist(layer.get("traces", [])),
        "pads": qlist(layer.get("pads", [])),
        "pads_rect": qlist(layer.get("pads_rect", [])),
        "arcs": qlist(layer.get("arcs", [])),
        "surfaces": [[v if isinstance(v, str) else q(v) for v in p]
                     for p in layer.get("surfaces", [])],
        "trace_count": layer.get("trace_count", len(layer.get("traces", [])) // 5),
        "pad_count": layer.get("pad_count", len(layer.get("pads", [])) // 3),
    }


def pack_outline(o):
    segs = []
    for s in o.get("segments", []):
        t = s["type"]
        if t == "start":
            segs.append(["M", q(s["x"]), q(s["y"])])
        elif t == "line":
            segs.append(["L", q(s["x"]), q(s["y"])])
        elif t == "arc":
            segs.append(["A", q(s["end_x"]), q(s["end_y"]),
                         q(s["center_x"]), q(s["center_y"]),
                         1 if s.get("clockwise") else 0])
        elif t == "close":
            segs.append(["Z"])
    return {
        "min": [q(o["min_x"]), q(o["min_y"])],
        "max": [q(o["max_x"]), q(o["max_y"])],
        "w": q(o["width"]), "h": q(o["height"]),
        "segs": segs,
    }


def convert(meta, src_path, out_dir, dry_run, pinout_dir=None, primary_class=None):
    raw = json.loads(src_path.read_bytes())
    problems = []
    pinclasses = (read_pin_classes(pinout_dir, meta["id"], primary_class)
                  if pinout_dir else {})
    uartclasses = read_uart_classes(pinout_dir, meta["id"]) if pinout_dir else {}

    layers = raw.get("layers") or {"top": {"components": raw.get("components", []),
                                           "categories": raw.get("categories", {})}}
    base = {
        "id": meta["id"],
        "model": meta["model"],
        "name": meta["name"],
        "rev": meta["rev"],
        "soc": meta["soc"],
        "units": raw.get("units", "mm"),
        "outline": pack_outline(raw["outline"]),
        "categories": {},
        "components": {},
        "nets": raw.get("nets", {}),
        "pin_nets": qlist(raw.get("pin_nets", [])),
    }
    for side in ("top", "bot"):
        lay = layers.get(side)
        if not lay:
            continue
        base["categories"][side] = lay.get("categories", {})
        base["components"][side] = [
            pack_component(c, problems, f"{meta['id']}.{side}", pinclasses,
                           uartclasses)
            for c in lay.get("components", [])
        ]

    copper = [pack_copper(c) for c in raw.get("copper", [])]
    base["copper_index"] = [
        {"name": c["name"], "label": c["label"],
         "traces": c["trace_count"], "pads": c["pad_count"]}
        for c in copper
    ]
    if copper:
        base["copper_file"] = f"{meta['id']}.copper.json"

    check_clean(base.get("nets", {}), f"{meta['id']}.nets", problems)
    if problems:
        print(f"REFUSED {meta['id']}: {len(problems)} value(s) name a machine or "
              f"a path -- re-export from ODB++ with a current pcb_view.py:",
              file=sys.stderr)
        for p in problems[:10]:
            print("  " + p, file=sys.stderr)
        raise SystemExit(2)

    base_txt = json.dumps(base, separators=(",", ":"))
    copper_txt = json.dumps(copper, separators=(",", ":")) if copper else ""

    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{meta['id']}.json").write_text(base_txt)
        if copper_txt:
            (out_dir / f"{meta['id']}.copper.json").write_text(copper_txt)

    return {
        "src_mb": src_path.stat().st_size / 1e6,
        "base_mb": len(base_txt) / 1e6,
        "copper_mb": len(copper_txt) / 1e6,
        "top": len(base["components"].get("top", [])),
        "bot": len(base["components"].get("bot", [])),
        "layers": len(copper),
        "w": base["outline"]["w"], "h": base["outline"]["h"],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, type=Path,
                    help="directory holding the pcb_view.py --json exports")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "data",
                    help="site data directory to write (default: ../data)")
    ap.add_argument("--board", action="append",
                    help="only this board id (repeatable)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report sizes, write nothing")
    ap.add_argument("--pinout", type=Path,
                    default=Path(__file__).resolve().parents[2] / "hardware-gpio" / "data",
                    help="the pinout site's data dir, read for each header "
                         "pin's signal class (default: ../hardware-gpio/data)")
    args = ap.parse_args()

    primary_class = _pinout_primary_class(args.pinout)

    wanted = set(args.board or [])
    index = []
    total_src = total_base = total_copper = 0.0

    print(f"{'board':16s} {'status':11s} {'src':>8s} {'base':>8s} {'copper':>8s}  parts")
    for meta in BOARDS:
        if wanted and meta["id"] not in wanted:
            continue
        src = args.src / meta["src"]
        if not src.exists():
            print(f"{meta['id']:16s} MISSING {src}", file=sys.stderr)
            raise SystemExit(1)
        st = convert(meta, src, args.out, args.dry_run, args.pinout,
                     primary_class)
        total_src += st["src_mb"]
        total_base += st["base_mb"]
        total_copper += st["copper_mb"]
        print(f"{meta['id']:16s} {meta['status']:11s} "
              f"{st['src_mb']:7.2f}M {st['base_mb']:7.2f}M {st['copper_mb']:7.2f}M  "
              f"{st['top']}+{st['bot']}")
        row = {k: meta[k] for k in
               ("id", "model", "name", "rev", "soc", "vendor", "status", "hidden")}
        row.update(size_mm=[st["w"], st["h"]], layers=st["layers"],
                   parts={"top": st["top"], "bot": st["bot"]})
        if meta.get("shares_layout_with"):
            row["shares_layout_with"] = meta["shares_layout_with"]
        index.append(row)

    print(f"{'total':16s} {'':11s} {total_src:7.2f}M {total_base:7.2f}M "
          f"{total_copper:7.2f}M")

    if not args.dry_run and not wanted:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "boards.json").write_text(json.dumps(
            {"generated": date.today().isoformat(), "boards": index},
            indent=1) + "\n")
        n_hidden = sum(1 for b in index if b["hidden"])
        print(f"\nboards.json: {len(index)} boards, {n_hidden} unlisted")
    elif wanted:
        print("\n(--board given: boards.json left alone)")


if __name__ == "__main__":
    main()
