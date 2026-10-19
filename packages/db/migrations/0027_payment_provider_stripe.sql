-- 0027 · Stripe como provedor de recebimento (Connect). So o valor do enum: um valor novo
-- nao pode ser usado na mesma transacao que o cria, entao o uso fica na 0028.
ALTER TYPE public.payment_provider ADD VALUE IF NOT EXISTS 'STRIPE';
