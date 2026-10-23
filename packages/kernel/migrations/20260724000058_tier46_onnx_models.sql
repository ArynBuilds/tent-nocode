-- Tier 46 Phase G (FR-423, D-174) — the ONNX rung on its spike GO: model-carrying
-- operations. ADDITIVE: a model is a hash-pinned, consent-born operation ASSET —
-- model_hash is the pin (the executor's content-addressed store keys on it; every load
-- re-verifies and refuses on drift), model_path the authoring-time source the first
-- execution copies from, model_license the card-rendered obligation. NULL everywhere =
-- the operation carries no model (every pre-G row, unchanged).
alter table operations add column model_hash text null;
alter table operations add column model_path text null;
alter table operations add column model_license text null;
