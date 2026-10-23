# Third-party notices — vendored operation runtime (Pyodide)

Everything in this directory is the hash-pinned, offline-only runtime for engine-owned
OPERATIONS (Tier 42, D-168/FR-417). Nothing here is ever fetched at run time — packages
load exclusively from this directory; the operation sandbox has no network primitive.
`MANIFEST.sha256.json` is the pin record for every file (core runtime copied byte-exact
from the official npm package `pyodide@314.0.2`; wheels downloaded once at vendoring
time from the official Pyodide v314.0.2 release CDN and verified against the release's
own `pyodide-lock.json` sha256 entries before being written).

## Pyodide 314.0.2 (CPython 3.14.0 compiled to WebAssembly)

Source: npm `pyodide@314.0.2` (`pyodide.js`, `pyodide.mjs`, `pyodide.asm.mjs`,
`pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json` + source maps).

```
Mozilla Public License Version 2.0

Copyright (c) 2018-2026, Pyodide contributors and Mozilla

This Source Code Form is subject to the terms of the Mozilla Public License,
v. 2.0. If a copy of the MPL was not distributed with this file, You can
obtain one at https://mozilla.org/MPL/2.0/.
```

Full license text: https://github.com/pyodide/pyodide/blob/main/LICENSE

## Python packages (curated wheel set)

The `.whl` files are unmodified binary wheels from the same Pyodide v314.0.2 release,
each carrying its own license inside the wheel's `*.dist-info` metadata. The curated
set (numpy, scipy, pandas, scikit-image + their lock-resolved dependency closure) is
predominantly BSD-3-Clause (numpy, scipy, pandas, scikit-image, networkx, imageio,
pywavelets, lazy_loader, cycler), with Apache-2.0/BSD dual (packaging, python-dateutil),
MIT (pytz, setuptools, pyparsing, six, fonttools, kiwisolver), PSF/BSD (matplotlib,
contourpy), and MIT-CMU (pillow). No wheel is patched; provenance and integrity are
pinned per-file in `MANIFEST.sha256.json`.
