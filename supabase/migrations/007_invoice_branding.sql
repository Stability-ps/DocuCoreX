-- Invoice branding: issuer (your business) details + logo so the invoice can render a full
-- dual-header (your business vs. client) format similar to the reference implementation,
-- plus support for a live in-app preview before printing/saving/emailing.

alter table public.invoices
  add column if not exists issuer_name text,
  add column if not exists issuer_email text,
  add column if not exists issuer_phone text,
  add column if not exists issuer_address text,
  add column if not exists logo_data_url text;
