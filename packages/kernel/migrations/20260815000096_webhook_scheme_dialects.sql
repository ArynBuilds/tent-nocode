-- F31 THE DIALECT SLICE: the webhook scheme check widens to the signed-vendor
-- dialects (slack v0 - linear - gitlab token - calendly - telegram token -
-- box base64 dual-header). Docs-exact math lives in
-- packages/kernel/src/integrations/webhooks.ts (WEBHOOK_SCHEMES is the one
-- registry). Twilio (HMAC-SHA1 over the public URL) is a named user fork and
-- stays out; mailchimp signs nothing (its lane is the urlencoded parse, not a
-- scheme). Append-only law: this re-mints the 90 check widened.
alter table webhook_endpoints
  drop constraint webhook_endpoints_scheme_check;
alter table webhook_endpoints
  add constraint webhook_endpoints_scheme_check
  check (scheme in ('generic', 'stripe', 'paddle', 'slack', 'linear', 'gitlab', 'calendly', 'telegram', 'box'));
