# Third-party notices — vendored inference runtime (ONNX Runtime Web)

Everything in this directory is the hash-pinned, offline-only inference runtime for
model-carrying engine OPERATIONS (Tier 46, D-174/FR-423 — models as muscle: pretrained
nets as SEALED DETERMINISTIC COMPUTE, the zero-LLM law intact). Nothing here is ever
fetched at run time — the wasm loader resolves from this directory via a file:// URL,
and model bytes are read + hash-verified by the executor and passed as a buffer
(`InferenceSession.create(bytes)`; the fetch()ing path is structurally unused).
`MANIFEST.sha256.json` is the pin record (files copied byte-exact from the official npm
package `onnxruntime-web@1.27.0`; tarball sha256 recorded there).

## ONNX Runtime Web 1.27.0

Source: npm `onnxruntime-web@1.27.0` (`ort.js` + `ort-wasm-simd-threaded.mjs` +
`ort-wasm-simd-threaded.wasm` — the wasm execution path only).

License: MIT

> MIT License
>
> Copyright (c) Microsoft Corporation
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify,
> merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following
> conditions:
>
> The above copyright notice and this permission notice shall be included in all copies
> or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
> PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
> HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
> OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

MODEL ASSETS are never part of this directory: each model is a hash-pinned,
consent-born operation asset (the card renders its hash + license + size verbatim at
graduation; the content-addressed store under the runner's workspace root holds the
bytes; every load re-verifies the hash and refuses on drift).
