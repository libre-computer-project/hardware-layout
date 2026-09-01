# Libre Computer Board Layout

Where every part sits on the board, and where every trace runs between them,
read out of each board's own CAD data.

Companion to the [GPIO pinout](https://github.com/libre-computer-project/hardware-gpio):
that site answers *what is this pin*, this one answers *where is this part*.
Same palette, same board vocabulary, same `?board=` permalinks.

## Using it

| Do this | To get |
|---|---|
| Drag, scroll or pinch | Pan and zoom the board |
| Click a part, or a row in the sidebar | Select it, with its footprint, size, rotation and pin count |
| Right-click near a pad | Highlight that net's pads across **every** copper layer, including the ones switched off |
| <kbd>T</kbd> / <kbd>B</kbd> | Top or bottom side |
| <kbd>1</kbd>–<kbd>8</kbd> | Toggle a copper layer |
| <kbd>F</kbd> | Fit the board to the window |
| <kbd>Esc</kbd> | Clear the selection and the net highlight |

`?board=<id>` is a permalink to one board.

## Where each board's data comes from

Most boards have an ODB++ export, which carries everything: placement, all
eight copper layers, the netlist, drill. Some never had one, and are imported
from a mechanical model instead — that has the placement, the pads, the values
and the hole sizes, but **no netlist and no copper routing**. On those boards
the copper toggles are absent and right-click net highlighting does nothing,
because the source does not contain what they would show. `layers` in
`data/boards.json` says which is which: 8 for an ODB++ board, 0 for a
mechanical one.

| Source | Boards | Placement | Copper | Nets |
|---|---|---|---|---|
| ODB++ | all but La Frite | 🟢 | 🟢 8 layers | 🟢 |
| PADS mechanical DXF | La Frite (`AML-S805X-AC`) | 🟢 | 🔴 none | 🔴 none |

A CAD export carries a good deal that describes how a board was drawn rather
than what it is, and none of that is needed to draw a board. Per-component
`properties` are therefore **allowlisted at export time** — a field is
published because it was named, not because it survived a filter.
[`tools/check-site.py`](tools/check-site.py) asks the same question again about
the committed tree, and CI will not deploy a tree that fails it.

## Layout

```
index.html            the page
css/lc-kit.css        VENDORED shell: theme, top bar, footer, controls
js/lc-kit.js          VENDORED shell: theme cycle, mountShell(), token()
css/style.css         this tool only: copper palette, board, canvas stage
js/app.js             the viewer: canvas render, filters, net highlight
data/boards.json      the board index the picker is built from
data/<id>.json        outline, placement, categories, netlist   -- always fetched
data/<id>.copper.json the eight copper layers                   -- fetched on demand
tools/gen-layout-data.py   ODB++ export -> the two data files
tools/check-site.py        the pre-publish gate CI runs
tools/check-kit.py         proves the vendored shell has not been hand-edited
```

**Do not edit `css/lc-kit.css` or `js/lc-kit.js` here.** They are the shell this
site shares with the [GPIO pinout](https://gpio.hardware.libre.computer), and
each carries a checksum of its own body in its first line.
`tools/check-kit.py` recomputes it in CI, so a local change fails the build —
and the next sync would revert it anyway. The change belongs upstream, where
the kit is maintained.

The split is the point. A visitor who never turns on a copper layer pays for
the placement alone: **80 KB gzipped** for the largest board. Routing arrives
only if a layer is asked for.

| | Source exports | Published |
|---|---|---|
| All boards | 41.3 MB | 26.9 MB |
| First paint, largest board (Alta) | 4.88 MB | 0.37 MB raw / **0.08 MB gzipped** |
| First paint, smallest board (La Frite) | 1.09 MB | 0.18 MB raw |
| Routing, largest board | — | 2.56 MB raw / 0.71 MB gzipped, on demand |

## Regenerating the data

The generator reads the ODB++ exports, which are not public, so it runs on a
machine that has them and the output is committed. CI does not regenerate; it
validates.

```sh
tools/gen-layout-data.py --src <dir-of-pcb_view-json>      # rewrite data/
tools/gen-layout-data.py --src <dir> --dry-run             # sizes only
tools/gen-layout-data.py --src <dir> --board aml-a311d-cc  # one board
tools/check-site.py                                        # what CI will run
```

Adding a board is a row in `BOARDS` in the generator, then a regenerate. The
row carries the id, the marketing name, the SoC and the status; nothing about a
board is configured in two places.

## Two products, one PCB

`AML-A311D-CC` (Alta) and `AML-S905D3-CC` (Solitude) draw identically because
they **are** one layout: the A311D (G12B) and the S905D3 (SM1) share the
`G12A_16X14_3MM` package, and the two ODB++ archives — different job names,
exported four minutes apart — agree on every field this site reads, down to all
465 nets and all 679 part positions. Each board's page says so and links to its
sibling, so the repetition reads as the hardware rather than as a mix-up in the
data.

## Serving it locally

```sh
python3 -m http.server 8900     # then http://localhost:8900/
```

`file://` will not work: the page fetches its data, and the browser blocks that
from a file URL.

## Publishing

The site is `layout.hardware.libre.computer`, served by GitHub Pages from this
repository's `master` and gated by `.github/workflows/pages.yml` — a failing
`tools/check-site.py` stops the deploy rather than annotating it.

**`LICENSE` is still absent and deliberate.** The code and the CAD-derived
board data are not obviously the same licensing question, and neither is
settled here.
