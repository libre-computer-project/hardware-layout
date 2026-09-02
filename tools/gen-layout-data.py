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
GPIO_HEADER_KEY = "__gpio40__"   # not a refdes: the two sites disagree on that


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
        # SAY so. Returning None silently meant that with the pinout repo not
        # beside this one the build still exited 0, printed nothing, and shipped
        # boards with every header uncoloured -- a full-scale loss of a feature,
        # indistinguishable in the output from a board that has no pinout.
        # Not "no board's headers will carry signal classes" -- that was
        # false. The console headers found in a board's OWN netlist do not go
        # through here at all, so the MediaTek pair keep their cable colours;
        # what is lost is the signal classes the pinout supplies.
        print(f"note: {src} not found -- no board will carry the pinout's "
              f"signal classes (console headers read from a board's own "
              f"netlist are unaffected)", file=sys.stderr)
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
    out = {}
    for h in data.get("headers", []):
        pins = h.get("pins") or []
        if len(pins) != 3 or not h.get("id"):
            continue
        wires = {str(p["pin"]): _uart_wire(p) for p in pins
                 if p.get("pin") is not None}
        # EVERY qualifying header, not the first. This returned from inside the
        # loop, so a board could only ever have one console header here.
        #
        # It changes nothing TODAY, and the honest reason is not the one first
        # given: the MediaTek boards do have two console headers each, but they
        # have no pinout file, so this function never runs on them and their
        # two come from uart_headers_from_nets. Across all 14 board files in
        # that directory -- 15 entries, one of which is the boards.json
        # manifest and carries no headers -- none has a second qualifying 3-pin
        # header. This is a latent bug fixed on principle: a loop that stops at
        # the first match while its caller expects every match.
        if set(wires.values()) == {"wire-gnd", "wire-tx", "wire-rx"}:
            out[h["id"]] = wires
    return out


NET_GND = re.compile(r"(^|_)(D_)?GND(\d*)$|(^|_)GND(_|$)", re.IGNORECASE)
# A UART line, and NOT merely a name with TX or RX in it. This started as
# "contains TX", which in this very data also picks up the HDMI power rails
# TX_OVDD / TX_OVDD33 / TX_AVCC12, the DDC I2C line TX_DDCSCL, the differential
# pair HDMI0_TX0_P, the audio return ARC_RX and the PHY strap RXD1_TXDLY. None
# is a console signal. Only the three-pad connector gate stopped those from
# colouring something, which is one gate too few for a rule that decides what a
# pin IS.
#
# Narrow, then not TOO narrow. The first cut of this took anything containing
# TX; the second took so little that six real console spellings in this very
# data stopped matching -- DEBUG_TX, UART_AO_B_TX, UART_A_TX, UART_C_TX,
# LINUX_TX and RASPI_UTXD2. Amlogic writes UART_<port>_TX, and a pattern that
# cannot read the vendor whose boards these mostly are is the wrong pattern.
# None sits on a 3-pad connector today, so nothing was mis-drawn; it would have
# failed the moment one did.
NET_TX = re.compile(
    r"^(U|UART\d*_?|DEBUG_|LINUX_|RASPI_U?)?TXD?\d*$"
    r"|(^|_)UART(_?[A-Z]\d?)*_?TXD?\d*(_|$)",
    re.IGNORECASE)
NET_RX = re.compile(
    r"^(U|UART\d*_?|DEBUG_|LINUX_|RASPI_U?)?RXD?\d*$"
    r"|(^|_)UART(_?[A-Z]\d?)*_?RXD?\d*(_|$)",
    re.IGNORECASE)
# Whatever the name suggests, these are never a console signal.
NET_NOT_UART = re.compile(
    r"VDD|VCC|AVCC|OVDD|VBUS|_P$|_N$|SCL|SDA|DDC|LED|DLY|ARC|SHIELD|CLK",
    re.IGNORECASE)


def uart_headers_from_nets(raw):
    """Console headers found in the board's OWN netlist.

    Runs on EVERY board, and its answers are merged per header UNDER the
    pinout's -- see the setdefault at the call site. It is not gated to boards
    without a pinout, and describing it that way would understate where a wrong
    answer here could land.

    The colour rule reads the pinout site, which is right when there is one --
    that site is where a pin's function is decided. But four of the ten boards
    have no pinout, and two of them name the answer in the file being rendered:
    MED-MT83-ACE and MTK-G500-MMD carry `D_GND` / `UART1_TX` / `UART1_RX` on J3
    and `D_GND` / `UTXD0` / `URXD0` on J4004. Those are exactly the ground +
    TX + RX the rule tests for, and both drew brass because the only place
    consulted was a file that does not exist.

    ONLY as a fallback, and only on a 3-pad connector whose three nets are one
    ground, one transmit and one receive -- nothing is guessed from a pin
    count or a position. A board like MED-MT88-MX, whose `J180` is a 3-pin
    header with no signal names to read, stays brass: undecidable from this
    repo is a reason to draw nothing, not to guess.
    """
    nets = raw.get("nets") or {}
    pin_nets = raw.get("pin_nets") or []
    if not nets or not pin_nets:
        return {}
    at = {}
    for i in range(0, len(pin_nets) - 2, 3):
        at[(round(pin_nets[i], 3), round(pin_nets[i + 1], 3))] = pin_nets[i + 2]

    def net_name(x, y):
        nid = at.get((round(x, 3), round(y, 3)))
        if nid is None:
            return ""
        return str(nets.get(str(nid), nets.get(nid, "")) or "")

    found = {}
    layers = raw.get("layers") or {}
    for side in ("top", "bot"):
        for c in (layers.get(side) or {}).get("components", []):
            pp = c.get("pin_pads")
            if not pp or c.get("category") != "connector":
                continue
            pads = []
            for g in pp.get("groups", []):
                pos = g.get("positions") or []
                names = g.get("pins") or []
                for i, n in enumerate(names):
                    pads.append((str(n), pos[2 * i], pos[2 * i + 1]))
            if len(pads) != 3:
                continue
            wires = {}
            for pin, x, y in pads:
                nm = net_name(x, y)
                if not nm:
                    break
                # The rejection list runs FIRST, ground included. Testing
                # ground first let GND_RX_SHIELD -- a shield, not a ground pin
                # -- classify as the ground wire, which is the one slot the
                # three-signal gate cannot catch, because a wrong ground still
                # leaves the set complete.
                if NET_NOT_UART.search(nm):
                    break
                if NET_GND.search(nm):
                    wires[pin] = "wire-gnd"
                elif NET_TX.search(nm):
                    wires[pin] = "wire-tx"
                elif NET_RX.search(nm):
                    wires[pin] = "wire-rx"
            if set(wires.values()) == {"wire-gnd", "wire-tx", "wire-rx"}:
                found[c["refdes"]] = wires
    return found


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

    def classes(header):
        m = {}
        for p in header.get("pins", []):
            if p.get("pin") is None:
                continue
            # `primary` once the pinout publishes it; until then, its
            # generator's own function applied to the same inputs. Never `cls`
            # -- that is a different question's answer.
            cls = p.get("primary")
            if not cls and primary_class:
                cls = primary_class(p.get("type"), p.get("cls"),
                                    p.get("funcs") or [])
            if cls:
                m[str(p["pin"])] = cls
        return m

    headers = data.get("headers", [])
    sized = [h for h in headers if len(h.get("pins", [])) == GPIO_HEADER_PINS]
    out = {GPIO_HEADER_KEY: classes(sized[0])} if len(sized) == 1 else {}

    # The SMALLER documented headers, keyed by their own id. These were skipped
    # wholesale, justified by AML-S905X-CC-V2's 2J3 being 8 pins against 7
    # pads. That was never a pin-count disagreement -- the header's pads arrive
    # in two SHAPE groups, 7 round and 1 square pin 1, and the comparison was
    # against a group instead of the part. Counted per part, 2J3 is 8 against 8
    # on both V2 and V3, so the stated reason has not held since the pad count
    # moved to the component.
    #
    # Matched on refdes AND total pad count, so the pairs where the two sites
    # disagree about what a connector is called simply do not match: the
    # pinout's 9J1 is a 3-pin header while the layout's 9J1 is a 19-pad part.
    for h in headers:
        if h.get("id") and len(h.get("pins", [])) != GPIO_HEADER_PINS:
            m = classes(h)
            if m:
                out[h["id"]] = m
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
        by_id = (pinclasses or {}).get(c["refdes"])
        colours = None
        if wires and pads == len(wires):
            # The console header first: it is also a documented header, and the
            # cable colours are the more specific answer for it.
            colours = wires
        elif (pads == GPIO_HEADER_PINS and (pinclasses or {}).get(GPIO_HEADER_KEY)
              and c.get("category") == "connector"):
            # Matched on pad COUNT, because the two sites disagree on this
            # header's refdes -- which means a SECOND 40-pad part would be
            # painted with the GPIO header's classes. Exactly one exists per
            # board today (7J1 x3, 7J2 x2, CON1 x2), so there is no live
            # defect, and `connector` is a cheap narrowing while the invariant
            # holds. gen_stats records it so a second one is not silent.
            colours = pinclasses.get(GPIO_HEADER_KEY)
        elif by_id and pads == len(by_id):
            colours = by_id

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
    # The pinout is authoritative where it exists; the board's own netlist
    # answers only for the headers it did not cover.
    for _ref, _wires in uart_headers_from_nets(raw).items():
        uartclasses.setdefault(_ref, _wires)

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
        # Board-level, because a hole goes THROUGH the board: the viewer draws
        # these on both sides, where a component is only ever on one.
        "holes": qlist(raw.get("holes", [])),
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

    # SAY when a documented header found no part to colour. The two sites do
    # not always agree what a connector is called -- the pinout's 9J5 does not
    # exist in AML-S805X-AC-V2's CAD (the part is 9J2), and its 9J1 is a 3-pin
    # header where the layout's 9J1 has 19 pads -- and matching on refdes plus
    # pad count means such a header silently colours nothing. Silent is the
    # problem: a mismatch is worth knowing about, and the alternative to
    # matching strictly is colouring the wrong part.
    # `any(pinclasses.values())`, not `pinclasses`. When the pinout DATA is
    # present but its generator is not, every per-header map comes back empty
    # and pinclasses is {"__gpio40__": {}} -- truthy, so this block ran and
    # found nothing to say while six boards shipped with their 40-pin header
    # uncoloured and no note at all.
    if any(pinclasses.values()):
        placed = {c["r"]: sum(len(g.get("pos", [])) // 2 for g in (c.get("pp") or []))
                  for side in ("top", "bot")
                  for c in base["components"].get(side, [])}
        pins_by_ref = {c["r"]: c.get("p") or 0
                       for side in ("top", "bot")
                       for c in base["components"].get(side, [])}
        coloured = {c["r"] for side in ("top", "bot")
                    for c in base["components"].get(side, [])
                    if any(g.get("cls") for g in (c.get("pp") or []))}
        for hid, m in pinclasses.items():
            # The 40-pin header is in here too, under its own key because the
            # two sites disagree about its refdes. Exempting it from this
            # report meant the one board where it colours NOTHING said nothing
            # -- AML-S805X-AC's 7J1 has no pad geometry at all, so the header a
            # reader most wants is blank and the build was silent about it.
            if hid == GPIO_HEADER_KEY:
                if not any(placed.get(r) == GPIO_HEADER_PINS for r in placed):
                    # The SAME three cases as below. Printing "no part here has
                    # 40 pads" was the vague wording this block was written to
                    # replace, reintroduced seven lines above the replacement:
                    # AML-S805X-AC's 7J1 exists, with pin_count 40, and simply
                    # carries no pad geometry.
                    named = [r for r, c in pins_by_ref.items()
                             if c == GPIO_HEADER_PINS]
                    if named:
                        why = (f"{', '.join(sorted(named))} has "
                               f"{GPIO_HEADER_PINS} pins but no pad geometry")
                    else:
                        why = f"no part here has {GPIO_HEADER_PINS} pins"
                    print(f"note {meta['id']}: the {GPIO_HEADER_PINS}-pin header "
                          f"is documented but not coloured ({why})",
                          file=sys.stderr)
                continue
            if hid in coloured:
                continue
            got = placed.get(hid)
            # Say WHICH of the three it is. "matched no part" was wrong for two
            # of the five it reported: the part exists, with that exact refdes,
            # and simply carries no pad geometry -- which is a different
            # problem with a different fix.
            if got is None:
                why = f"no {hid} in this CAD"
            elif got == 0:
                why = f"{hid} exists here but has no pad geometry"
            else:
                why = f"{hid} has {got} pads here"
            print(f"note {meta['id']}: pinout header {hid} ({len(m)} pins) "
                  f"not coloured ({why})", file=sys.stderr)

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
