import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { RESERVATION_TTL_MINUTES } from '@clubedarifa/shared';
import {
  cleanup,
  createHarness,
  hasTestDatabase,
  seedTenantWithSlug,
  skipReason,
  unique,
  type Harness,
} from './helpers/apiHarness.js';
import { FakePsp } from '@clubedarifa/psp/testing';

/**
 * M05 · pagamento PIX.
 *
 * O provedor e FALSO, mas a assinatura do webhook e verificada pelo adaptador
 * REAL. O teste decide o que o "PSP" responde a uma CONSULTA — e e so isso que
 * paga um pedido (RN06).
 */
describe.skipIf(!hasTestDatabase)(`Pagamento PIX ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let semPsp: Harness;
  let psp: FakePsp;
  let slug: string;
  let tenantId: string;

  beforeAll(async () => {
    psp = new FakePsp();
    harness = await createHarness({ psp });
    semPsp = await createHarness();
    await cleanup(harness.owner);

    slug = unique('pix-');
    tenantId = await seedTenantWithSlug(harness.owner, slug, 'Comunidade PIX');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await semPsp?.close();
  });

  // ---- cenario ------------------------------------------------------------

  async function sorteioAtivo(precoCents = 1500): Promise<string> {
    const { rows } = await harness.owner.query<{ id: string }>(
      `INSERT INTO draws (tenant_id, slug, title, prize_name, ticket_price_cents, total_numbers, status)
       VALUES ($1, $2, 'Sorteio PIX', 'Moto', $3, 100, 'ATIVA') RETURNING id`,
      [tenantId, unique('s-'), precoCents],
    );
    return rows[0]!.id;
  }

  function reservar(app: Harness, drawId: string, numbers: number[]) {
    return request(app.app)
      .post(`/api/public/draws/${drawId}/reservations`)
      .set('x-tenant-slug', slug)
      .send({ numbers });
  }

  function pedir(app: Harness, reservationId: string, email: string | null = 'maria@example.com') {
    return request(app.app)
      .post('/api/public/orders')
      .set('x-tenant-slug', slug)
      .send({
        reservationId,
        buyer: { name: 'Maria Souza', phone: '+55 11 91234-5678', ...(email ? { email } : {}) },
        acceptedTerms: true,
      });
  }

  /** Reserva, cria o pedido e devolve o que os testes precisam. */
  async function comprar(numbers: number[], opts: { drawId?: string; app?: Harness } = {}) {
    const app = opts.app ?? harness;
    const drawId = opts.drawId ?? (await sorteioAtivo());
    const reserva = await reservar(app, drawId, numbers);
    expect(reserva.status, JSON.stringify(reserva.body)).toBe(201);
    const pedido = await pedir(app, reserva.body.reservationId);
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    return { drawId, reserva: reserva.body, pedido: pedido.body, orderId: pedido.body.orderId as string };
  }

  function avisar(orderId: string, opts: { secret?: string } = {}) {
    const w = psp.signedWebhook(psp.idDoPedido(orderId), opts);
    return request(harness.app)
      .post(`/api/webhooks/mercadopago/${slug}`)
      .query(w.query)
      .set(w.headers)
      .send(w.body as object);
  }

  async function estado(orderId: string) {
    const { rows } = await harness.owner.query<{ status: string }>(
      'SELECT status::text AS status FROM orders WHERE id = $1',
      [orderId],
    );
    return rows[0]!.status;
  }

  async function numerosDoPedido(orderId: string): Promise<string[]> {
    const { rows } = await harness.owner.query<{ status: string }>(
      'SELECT status::text AS status FROM draw_numbers WHERE order_id = $1',
      [orderId],
    );
    return rows.map((r) => r.status);
  }

  async function contar(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await harness.owner.query<{ n: number }>(sql, params);
    return rows[0]!.n;
  }

  // -------------------------------------------------------------------------
  describe('gerar o PIX', () => {
    it('o checkout gera a cobranca e os numeros ficam PENDENTE', async () => {
      const { pedido, orderId } = await comprar([10, 11]);

      expect(pedido.status).toBe('PENDENTE');
      expect(pedido.payment).toMatchObject({ status: 'PENDENTE', needsManualRefund: false });
      expect(pedido.payment.copyPaste).toContain('FAKEPIX');
      expect(pedido.payment.qrCodeBase64).not.toBeNull();
      expect(await numerosDoPedido(orderId)).toEqual(['PENDENTE', 'PENDENTE']);
    });

    it('o prazo do PIX nunca passa do fim da reserva nem de 30 minutos', async () => {
      const { pedido, reserva } = await comprar([12]);

      const fimPix = new Date(pedido.payment.expiresAt).getTime();
      expect(fimPix).toBeLessThanOrEqual(new Date(reserva.expiresAt).getTime());
      expect(fimPix).toBeLessThanOrEqual(Date.now() + RESERVATION_TTL_MINUTES * 60_000 + 1_000);
    });

    it('idempotente: 5 chamadas simultaneas geram UMA cobranca', async () => {
      const { orderId } = await comprar([13]);

      const respostas = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(harness.app).post(`/api/public/orders/${orderId}/payment`).set('x-tenant-slug', slug),
        ),
      );

      for (const r of respostas) expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await contar('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [orderId])).toBe(1);
      expect(new Set(respostas.map((r) => r.body.payment.copyPaste)).size).toBe(1);
    });

    it('PSP fora do ar: o pedido existe, os numeros seguem segurados e da para tentar de novo', async () => {
      const drawId = await sorteioAtivo();
      const reserva = await reservar(harness, drawId, [14]);
      psp.falharProximaCriacao = 'unavailable';
      const pedido = await pedir(harness, reserva.body.reservationId);

      expect(pedido.status).toBe(201);
      expect(pedido.body.payment).toBeNull();
      expect(pedido.body.status).toBe('PENDENTE');
      expect(await numerosDoPedido(pedido.body.orderId)).toEqual(['PENDENTE']);

      // Ainda fora: erro claro e estavel.
      psp.falharProximaCriacao = 'unavailable';
      const falha = await request(harness.app)
        .post(`/api/public/orders/${pedido.body.orderId}/payment`)
        .set('x-tenant-slug', slug);
      expect(falha.status).toBe(503);
      expect(falha.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');

      // Voltou: a mesma chamada agora gera o PIX.
      const ok = await request(harness.app)
        .post(`/api/public/orders/${pedido.body.orderId}/payment`)
        .set('x-tenant-slug', slug);
      expect(ok.status).toBe(200);
      expect(ok.body.payment.status).toBe('PENDENTE');
    });

    it('sem provedor configurado: o pedido nasce e gerar PIX responde 503', async () => {
      const drawId = await sorteioAtivo();
      const reserva = await reservar(semPsp, drawId, [15]);
      const pedido = await pedir(semPsp, reserva.body.reservationId);
      expect(pedido.status).toBe(201);
      expect(pedido.body.payment).toBeNull();

      const res = await request(semPsp.app)
        .post(`/api/public/orders/${pedido.body.orderId}/payment`)
        .set('x-tenant-slug', slug);
      expect(res.status).toBe(503);
    });

    it('PIX pausado pelo criador: a reserva e recusada (409) e nenhum numero fica segurado', async () => {
      const drawId = await sorteioAtivo();
      await harness.owner.query(
        `INSERT INTO tenant_payment_preferences (tenant_id, disabled_methods) VALUES ($1, ARRAY['PIX'])
         ON CONFLICT (tenant_id) DO UPDATE SET disabled_methods = EXCLUDED.disabled_methods`,
        [tenantId],
      );
      try {
        const res = await reservar(harness, drawId, [60, 61]);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('PAYMENT_METHOD_DISABLED');
        const seguros = await contar("SELECT count(*)::int AS n FROM draw_numbers WHERE draw_id = $1 AND number IN (60, 61)", [drawId]);
        expect(seguros).toBe(0);
      } finally {
        await harness.owner.query('UPDATE tenant_payment_preferences SET disabled_methods = ARRAY[]::text[] WHERE tenant_id = $1', [tenantId]);
      }
      // Religado, volta a reservar normalmente.
      expect((await reservar(harness, drawId, [60, 61])).status).toBe(201);
    });

    it('migration 0026 ainda NAO aplicada: reserva e PIX seguem funcionando (codigo pode ir antes da migration)', async () => {
      await harness.owner.query('ALTER TABLE tenant_payment_preferences RENAME TO tenant_payment_preferences_ausente');
      try {
        const compra = await comprar([70, 71]);
        expect(compra.pedido.status).toBe('PENDENTE');
        expect(compra.pedido.payment).toMatchObject({ status: 'PENDENTE' });
      } finally {
        await harness.owner.query('ALTER TABLE tenant_payment_preferences_ausente RENAME TO tenant_payment_preferences');
      }
    });

    it('pedido de OUTRA comunidade nao gera PIX', async () => {
      const { orderId } = await comprar([16]);
      const outra = unique('alheia-');
      await seedTenantWithSlug(harness.owner, outra, 'Alheia');

      const res = await request(harness.app)
        .post(`/api/public/orders/${orderId}/payment`)
        .set('x-tenant-slug', outra);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('RN06 · so o PSP paga', () => {
    it('RN06_sem_confirmacao_do_psp_nao_paga: aviso valido, mas a consulta diz PENDENTE', async () => {
      const { orderId } = await comprar([20]);

      const res = await avisar(orderId);

      expect(res.status).toBe(200);
      expect(await estado(orderId)).toBe('PENDENTE');
      expect(await numerosDoPedido(orderId)).toEqual(['PENDENTE']);
    });

    it('corpo do webhook dizendo "aprovado" nao vale: a consulta manda', async () => {
      const { orderId } = await comprar([21]);
      const w = psp.signedWebhook(psp.idDoPedido(orderId));

      const res = await request(harness.app)
        .post(`/api/webhooks/mercadopago/${slug}`)
        .query(w.query)
        .set(w.headers)
        .send({ ...(w.body as object), status: 'approved', transaction_amount: 15 });

      expect(res.status).toBe(200);
      expect(await estado(orderId)).toBe('PENDENTE');
    });

    it('assinatura invalida -> 401 e nenhum efeito, mesmo com o PSP aprovando', async () => {
      const { orderId } = await comprar([22]);
      psp.approve(orderId);

      const res = await avisar(orderId, { secret: 'segredo-errado' });

      expect(res.status).toBe(401);
      expect(await estado(orderId)).toBe('PENDENTE');
    });

    it('sem cabecalho de assinatura -> 401', async () => {
      const { orderId } = await comprar([23]);
      psp.approve(orderId);
      const res = await request(harness.app)
        .post(`/api/webhooks/mercadopago/${slug}`)
        .query({ 'data.id': psp.idDoPedido(orderId), type: 'payment' })
        .send({ type: 'payment', data: { id: psp.idDoPedido(orderId) } });
      expect(res.status).toBe(401);
      expect(await estado(orderId)).toBe('PENDENTE');
    });

    it('a rota de desenvolvimento nao existe em producao', async () => {
      const producao = await createHarness({ nodeEnv: 'production', psp });
      try {
        const res = await request(producao.app)
          .post('/api/dev/orders/00000000-0000-4000-8000-000000000000/confirm-payment')
          .set('Host', `${slug}.clubedarifa.local`);
        expect([404]).toContain(res.status);
      } finally {
        await producao.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('RN07 · idempotencia do webhook', () => {
    it('RN07_webhook_5x_gera_1_venda (em sequencia)', async () => {
      const { orderId, drawId } = await comprar([30, 31]);
      psp.approve(orderId);

      for (let i = 0; i < 5; i += 1) {
        const res = await avisar(orderId);
        expect(res.status).toBe(200);
      }

      expect(await estado(orderId)).toBe('PAGO');
      expect(await numerosDoPedido(orderId)).toEqual(['PAGO', 'PAGO']);
      expect(
        await contar(
          `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'order.paid' AND payload->>'orderId' = $1`,
          [orderId],
        ),
        'order.paid publicado uma unica vez',
      ).toBe(1);
      expect(
        await contar(
          `SELECT count(*)::int AS n FROM audit_events WHERE action = 'order.paid' AND target_id = $1`,
          [orderId],
        ),
      ).toBe(1);
      expect(
        await contar("SELECT count(*)::int AS n FROM draw_numbers WHERE draw_id = $1 AND status = 'PAGO'", [drawId]),
      ).toBe(2);
    });

    it('RN07_webhook_5x_gera_1_venda (simultaneos)', async () => {
      const { orderId } = await comprar([32]);
      psp.approve(orderId);

      const respostas = await Promise.all(Array.from({ length: 5 }, () => avisar(orderId)));

      for (const r of respostas) expect(r.status).toBe(200);
      expect(await estado(orderId)).toBe('PAGO');
      expect(
        await contar(
          `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'order.paid' AND payload->>'orderId' = $1`,
          [orderId],
        ),
      ).toBe(1);
    });

    it('pago: o comprovante mostra PAGO, sem prazo, e o pagamento APROVADO', async () => {
      const { orderId } = await comprar([33]);
      psp.approve(orderId);
      await avisar(orderId);

      const res = await request(harness.app).get(`/api/public/orders/${orderId}`).set('x-tenant-slug', slug);
      expect(res.body).toMatchObject({ status: 'PAGO', expiresAt: null });
      expect(res.body.payment.status).toBe('APROVADO');
      expect(res.body.paidAt).not.toBeNull();
    });

    it('gerar PIX de pedido ja pago devolve o comprovante, sem nova cobranca', async () => {
      const { orderId } = await comprar([34]);
      psp.approve(orderId);
      await avisar(orderId);
      const antes = psp.calls.create;

      const res = await request(harness.app)
        .post(`/api/public/orders/${orderId}/payment`)
        .set('x-tenant-slug', slug);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PAGO');
      expect(psp.calls.create).toBe(antes);
    });
  });

  // -------------------------------------------------------------------------
  describe('conferencia com o que foi cobrado', () => {
    it('valor diferente do cobrado NAO paga e deixa rastro', async () => {
      const { orderId } = await comprar([40]);
      psp.approve(orderId, { amountCents: 100 });

      const res = await avisar(orderId);

      expect(res.status).toBe(200);
      expect(await estado(orderId)).toBe('PENDENTE');
      expect(
        await contar(
          `SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment.mismatch' AND target_type = 'payment'
             AND target_id IN (SELECT id::text FROM payments WHERE order_id = $1)`,
          [orderId],
        ),
      ).toBe(1);
    });

    it('referencia de outro pedido NAO paga', async () => {
      const { orderId } = await comprar([41]);
      psp.approve(orderId, { externalReference: '00000000-0000-4000-8000-000000000000' });

      await avisar(orderId);

      expect(await estado(orderId)).toBe('PENDENTE');
    });

    it('PSP cancelou ou expirou: o pagamento fecha, o pedido segue para a varredura', async () => {
      const { orderId } = await comprar([42]);
      psp.setStatus(orderId, 'EXPIRADO');

      const res = await avisar(orderId);

      expect(res.status).toBe(200);
      const { rows } = await harness.owner.query<{ status: string }>(
        'SELECT status::text AS status FROM payments WHERE order_id = $1',
        [orderId],
      );
      expect(rows[0]!.status).toBe('EXPIRADO');
      expect(await estado(orderId)).toBe('PENDENTE');
    });

    it('provedor fora na consulta: 503, para o PSP reenviar; nada muda', async () => {
      const { orderId } = await comprar([43]);
      psp.approve(orderId);
      psp.consultaIndisponivel = true;
      try {
        const res = await avisar(orderId);
        expect(res.status).toBe(503);
        expect(await estado(orderId)).toBe('PENDENTE');
      } finally {
        psp.consultaIndisponivel = false;
      }
      // O reenvio do PSP, agora com o provedor de volta, conclui a venda.
      expect((await avisar(orderId)).status).toBe(200);
      expect(await estado(orderId)).toBe('PAGO');
    });

    it('aviso que nao e de pagamento e reconhecido e ignorado', async () => {
      const { orderId } = await comprar([44]);
      psp.approve(orderId);
      const w = psp.signedWebhook(psp.idDoPedido(orderId));
      const res = await request(harness.app)
        .post(`/api/webhooks/mercadopago/${slug}`)
        .query({ 'data.id': w.query['data.id']!, type: 'plan' })
        .set(w.headers)
        .send({ type: 'plan', data: { id: w.query['data.id'] } });
      expect(res.status).toBe(200);
      expect(await estado(orderId)).toBe('PENDENTE');
    });

    it('comunidade desconhecida no caminho: 200 e nada acontece', async () => {
      const { orderId } = await comprar([45]);
      psp.approve(orderId);
      const w = psp.signedWebhook(psp.idDoPedido(orderId));
      const res = await request(harness.app)
        .post('/api/webhooks/mercadopago/comunidade-que-nao-existe')
        .query(w.query)
        .set(w.headers)
        .send(w.body as object);
      expect(res.status).toBe(200);
      expect(await estado(orderId)).toBe('PENDENTE');
    });

    it('a mesma cobranca avisada pela comunidade ERRADA nao paga (RLS)', async () => {
      const { orderId } = await comprar([46]);
      psp.approve(orderId);
      const outra = unique('errada-');
      await seedTenantWithSlug(harness.owner, outra, 'Errada');
      const w = psp.signedWebhook(psp.idDoPedido(orderId));

      const res = await request(harness.app)
        .post(`/api/webhooks/mercadopago/${outra}`)
        .query(w.query)
        .set(w.headers)
        .send(w.body as object);

      expect(res.status).toBe(200);
      expect(await estado(orderId)).toBe('PENDENTE');
    });

    it('sem provedor configurado, o webhook nao existe (404)', async () => {
      const res = await request(semPsp.app).post(`/api/webhooks/mercadopago/${slug}`).send({});
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('pagamento depois de a reserva vencer (Suposicao S4)', () => {
    /** Simula a varredura: devolve os numeros do pedido a grade e cancela o pedido. */
    async function devolverNumeros(orderId: string): Promise<void> {
      await harness.owner.query(
        `UPDATE draw_numbers
            SET status = 'RESERVADO', expires_at = now() - interval '1 minute',
                order_id = NULL, reservation_id = NULL
          WHERE order_id = $1`,
        [orderId],
      );
      await harness.owner.query("UPDATE orders SET status = 'CANCELADO' WHERE id = $1", [orderId]);
    }

    it('numero ainda livre: a venda se conclui', async () => {
      const { orderId } = await comprar([50, 51]);
      await devolverNumeros(orderId);
      psp.approve(orderId);

      const res = await avisar(orderId);

      expect(res.status).toBe(200);
      expect(await estado(orderId)).toBe('PAGO');
      expect(await numerosDoPedido(orderId)).toEqual(['PAGO', 'PAGO']);
    });

    it('numero ja de outra pessoa: NAO vende de novo, marca estorno manual e avisa', async () => {
      const drawId = await sorteioAtivo();
      const { orderId } = await comprar([60, 61], { drawId });
      await devolverNumeros(orderId);

      // Outra pessoa pega o 60 enquanto o primeiro pagamento nao chegou.
      const outra = await reservar(harness, drawId, [60]);
      expect(outra.status).toBe(201);

      psp.approve(orderId);
      const res = await avisar(orderId);

      expect(res.status).toBe(200);
      expect(await estado(orderId)).toBe('CANCELADO');
      // Nada foi reivindicado pela metade: o 61 continua livre, o 60 e da outra pessoa.
      expect(await numerosDoPedido(orderId)).toEqual([]);

      const { rows } = await harness.owner.query<{
        status: string;
        needs_manual_refund: boolean;
        refund_reason: string;
      }>('SELECT status::text AS status, needs_manual_refund, refund_reason FROM payments WHERE order_id = $1', [
        orderId,
      ]);
      expect(rows[0]).toMatchObject({ status: 'APROVADO', needs_manual_refund: true });
      expect(rows[0]!.refund_reason).toContain('60');

      expect(
        await contar(
          `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'payment.refund_required' AND payload->>'orderId' = $1`,
          [orderId],
        ),
      ).toBe(1);
      expect(
        await contar(
          `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'order.paid' AND payload->>'orderId' = $1`,
          [orderId],
        ),
      ).toBe(0);

      // O dono novo do 60 continua dono.
      const { rows: dono } = await harness.owner.query<{ status: string; reservation_id: string }>(
        'SELECT status::text AS status, reservation_id FROM draw_numbers WHERE draw_id = $1 AND number = 60',
        [drawId],
      );
      expect(dono[0]!.status).toBe('RESERVADO');
      expect(dono[0]!.reservation_id).toBe(outra.body.reservationId);

      // E o painel (comprovante) enxerga o aviso.
      const comprovante = await request(harness.app)
        .get(`/api/public/orders/${orderId}`)
        .set('x-tenant-slug', slug);
      expect(comprovante.body.payment.needsManualRefund).toBe(true);
    });

    it('reenvio do mesmo aviso de estorno manual nao duplica o evento', async () => {
      const drawId = await sorteioAtivo();
      const { orderId } = await comprar([70], { drawId });
      await devolverNumeros(orderId);
      await reservar(harness, drawId, [70]);
      psp.approve(orderId);

      await avisar(orderId);
      await avisar(orderId);
      await avisar(orderId);

      expect(
        await contar(
          `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'payment.refund_required' AND payload->>'orderId' = $1`,
          [orderId],
        ),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('RN04 · concorrencia', () => {
    it('RN04_100_reservas_simultaneas_1_vencedor', async () => {
      const drawId = await sorteioAtivo();

      const respostas = await Promise.all(
        Array.from({ length: 100 }, () => reservar(harness, drawId, [77])),
      );

      const vencedoras = respostas.filter((r) => r.status === 201);
      const derrotadas = respostas.filter((r) => r.status === 409);
      expect(vencedoras).toHaveLength(1);
      expect(derrotadas).toHaveLength(99);
      expect(
        await contar('SELECT count(*)::int AS n FROM draw_numbers WHERE draw_id = $1 AND number = 77', [drawId]),
      ).toBe(1);
    }, 120_000);
  });
});
