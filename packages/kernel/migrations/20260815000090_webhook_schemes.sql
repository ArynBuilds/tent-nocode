-- THE VENDOR SIGNATURE SCHEMES (the checkout embed's F4 pairing, S14
-- docs-exact): a webhook endpoint declares which vendor's signature dialect
-- it speaks. generic = HMAC-SHA256 hex over the raw body (the standing
-- shape; Lemon Squeezy's X-Signature matches it); stripe = Stripe-Signature
-- t=<ts>,v1=<sig> over `ts.rawBody`; paddle = Paddle-Signature ts=..;h1=..
-- over `ts:rawBody`. PayPal is asymmetric (no shared secret) - recorded,
-- not a scheme.
alter table webhook_endpoints
  add column scheme text not null default 'generic'
  check (scheme in ('generic', 'stripe', 'paddle'));
