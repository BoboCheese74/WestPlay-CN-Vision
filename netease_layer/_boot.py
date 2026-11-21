"""Starts NetEase Cloud Music's layer with the interpreter it is lent.

The layer ships as code only: QQ Music's layer already carries an embeddable CPython, and a second copy
was eighteen megabytes of the same files. Embedded CPython runs with a `._pth` file, which turns off
`PYTHONPATH` — so the path to this code is put on `sys.path` here, then the layer's own `main` runs.

`crates/host/src/netease_layer.rs` runs this file (it looks for it beside the code).
"""

import sys

from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from netease_layer.__main__ import main  # noqa: E402 — after the path is set

if __name__ == "__main__":
    sys.exit(main())
