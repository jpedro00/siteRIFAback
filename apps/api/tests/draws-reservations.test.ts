import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { RESERVATION_TTL_MINUTES } from '@campaigns/shared';
import {
  cleanup,
  createHarness,
  grantMembership,
  hasTestDatabase,
  loginAs,
  seedAccount,
  seedTenantWithSlug,
  skipReason,
  unique,
  type Harness,
} from './helpers/apiHarness.js';

/**
 * Fase 2 · sorteio, grade, reserva e pedido.
 *
 * O teste que mais importa aqui e o de CONCORRENCIA. Todos os outros
 * descrevem o caminho feliz; aquele descreve o unico momento em que o produto
 * pode vender o mesmo numero duas vezes — e transformar uma venda em disputa.
 */
describe.skipIf(!hasTestDatabase)(`Fase 2 · sorteios ${hasTestDatabase ? '' : skipReason}`, () => {
  let harness: Harness;
  let slug: string;
  let tenantId: string;
  let cookie: string;

  beforeAll(async () => {
    harness = await createHarness();
    await cleanup(harness.owner);

    slug = unique('rifa-');
    tenantId = await seedTenantWithSlug(harness.owner, slug);
    const conta = await seedAccount(harness.owner);
    // OPERATOR tem `draw:write` e `draw:lifecycle:write` e NAO exige MFA:
    // exercita a permissao de sorteio sem arrastar RN12 para dentro deste teste.
    await grantMembership(harness.owner, {
      tenantId,
      userId: conta.userId,
      role: 'OPERATOR',
    });
    cookie = (await loginAs(harness, conta)).cookie;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  /** Cria um sorteio e, por padrao, ja o coloca em venda. */
  async function criarSorteio(
    overrides: Record<string, unknown> = {},
    ativar = true,
  ): Promise<{ id: string; slug: string; unitPriceCents: number }> {
    const res = await request(harness.app)
      .post('/api/tenant/draws')
      .set('Cookie', cookie)
      .set('x-tenant-slug', slug)
      .send({
        title: `Sorteio ${unique('t-')}`,
        prizeName: 'Moto 0 km',
        unitPriceCents: 1500,
        totalNumbers: 100,
        ...overrides,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    if (ativar) {
      const ativacao = await request(harness.app)
        .post(`/api/tenant/draws/${res.body.id}/status`)
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug)
        .send({ status: 'ATIVA' });
      expect(ativacao.status).toBe(200);
    }
    return { id: res.body.id, slug: res.body.slug, unitPriceCents: res.body.unitPriceCents };
  }

  function reservar(drawId: string, numbers: number[]) {
    return request(harness.app)
      .post(`/api/public/draws/${drawId}/reservations`)
      .set('x-tenant-slug', slug)
      .send({ numbers });
  }

  /**
   * Envelhece uma reserva ate depois do prazo.
   *
   * Move `created_at` JUNTO com `expires_at`, em vez de so puxar o vencimento
   * para tras. A CHECK `reservations_expires_after_creation` existe para que
   * nenhuma reserva nasca vencida, e o teste nao pode pedir ao banco um estado
   * que a producao proibe — o que se quer simular e a passagem do tempo: uma
   * reserva FEITA ha mais de 30 minutos, nao uma reserva impossivel.
   */
  async function envelhecerReserva(reservationId: string): Promise<void> {
    await harness.owner.query(
      `UPDATE reservations
          SET created_at = now() - interval '31 minutes',
              expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [reservationId],
    );
    await harness.owner.query(
      `UPDATE draw_numbers SET expires_at = now() - interval '1 minute'
        WHERE reservation_id = $1`,
      [reservationId],
    );
  }

  // -------------------------------------------------------------------------
  describe('criacao e ciclo de vida', () => {
    it('nasce em RASCUNHO e nao aparece na vitrine', async () => {
      // Sorteio em construcao nao pode vazar para o publico.
      const draw = await criarSorteio({}, false);
      const publico = await request(harness.app)
        .get('/api/public/draws')
        .set('x-tenant-slug', slug);
      expect(publico.status).toBe(200);
      expect(publico.body.draws.map((d: { id: string }) => d.id)).not.toContain(draw.id);
    });

    it('ativado, passa a aparecer na vitrine', async () => {
      const draw = await criarSorteio();
      const publico = await request(harness.app)
        .get('/api/public/draws')
        .set('x-tenant-slug', slug);
      expect(publico.body.draws.map((d: { id: string }) => d.id)).toContain(draw.id);
    });

    it('RN13 · so aceita grade de 100, 500 ou 1000', async () => {
      for (const total of [100, 500, 1000]) {
        const ok = await request(harness.app)
          .post('/api/tenant/draws')
          .set('Cookie', cookie)
          .set('x-tenant-slug', slug)
          .send({ title: `Grade ${total}`, prizeName: 'Premio', unitPriceCents: 100, totalNumbers: total });
        expect(ok.status, `grade ${total} deveria ser aceita`).toBe(201);
      }
      const ruim = await request(harness.app)
        .post('/api/tenant/draws')
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug)
        .send({ title: 'Grade 250', prizeName: 'Premio', unitPriceCents: 100, totalNumbers: 250 });
      expect(ruim.status).toBe(400);
    });

    it('RN13 · os rotulos seguem o tamanho da grade', async () => {
      // 100 -> 00..99 (2 digitos) | 500 e 1000 -> 000..999 (3 digitos)
      const esperado: Record<number, 2 | 3> = { 100: 2, 500: 3, 1000: 3 };
      for (const total of [100, 500, 1000] as const) {
        const draw = await criarSorteio({ totalNumbers: total });
        const grade = await request(harness.app)
          .get(`/api/public/draws/${draw.id}/numbers`)
          .set('x-tenant-slug', slug);
        expect(grade.body.labelDigits, `grade ${total}`).toBe(esperado[total]);
        expect(grade.body.totalNumbers).toBe(total);
      }
    });

    it('nao volta de VENDAS ENCERRADAS para ATIVA', async () => {
      // Reabrir a venda de uma grade fechada mudaria o resultado depois do fim.
      const draw = await criarSorteio();
      const fechar = await request(harness.app)
        .post(`/api/tenant/draws/${draw.id}/status`)
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug)
        .send({ status: 'VENDAS ENCERRADAS' });
      expect(fechar.status).toBe(200);

      const reabrir = await request(harness.app)
        .post(`/api/tenant/draws/${draw.id}/status`)
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug)
        .send({ status: 'ATIVA' });
      expect(reabrir.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  describe('reserva', () => {
    it('reserva os numeros pedidos por 30 minutos (RN05)', async () => {
      const draw = await criarSorteio();
      const res = await reservar(draw.id, [7, 13, 42]);

      expect(res.status).toBe(201);
      expect(res.body.numbers).toEqual([7, 13, 42]);
      expect(res.body.totalCents).toBe(draw.unitPriceCents * 3);

      const restante = new Date(res.body.expiresAt).getTime() - Date.now();
      const esperado = RESERVATION_TTL_MINUTES * 60_000;
      expect(restante).toBeGreaterThan(esperado - 120_000);
      expect(restante).toBeLessThanOrEqual(esperado + 5_000);
    });

    it('a grade passa a mostrar os numeros como RESERVADO', async () => {
      const draw = await criarSorteio();
      await reservar(draw.id, [1, 2]);

      const grade = await request(harness.app)
        .get(`/api/public/draws/${draw.id}/numbers`)
        .set('x-tenant-slug', slug);
      const porNumero = new Map(
        (grade.body.taken as { number: number; status: string }[]).map((t) => [t.number, t.status]),
      );
      expect(porNumero.get(1)).toBe('RESERVADO');
      expect(porNumero.get(2)).toBe('RESERVADO');
      // LIVRE nao trafega: o numero 3 simplesmente nao esta na resposta.
      expect(porNumero.has(3)).toBe(false);
    });

    it('numero ja reservado devolve 409 dizendo QUAIS', async () => {
      const draw = await criarSorteio();
      await reservar(draw.id, [10, 11]);

      const res = await reservar(draw.id, [11, 12]);
      expect(res.status).toBe(409);
      expect(res.body.error.details.unavailableNumbers).toEqual([11]);
    });

    it('a reserva e TUDO OU NADA', async () => {
      // O ponto: 12 estava livre no pedido anterior e NAO pode ter ficado preso
      // a uma reserva que falhou.
      const draw = await criarSorteio();
      await reservar(draw.id, [10]);
      await reservar(draw.id, [10, 12]); // falha por causa do 10

      const grade = await request(harness.app)
        .get(`/api/public/draws/${draw.id}/numbers`)
        .set('x-tenant-slug', slug);
      const numeros = (grade.body.taken as { number: number }[]).map((t) => t.number);
      expect(numeros).toContain(10);
      expect(numeros, '12 ficou preso a uma reserva que falhou').not.toContain(12);
    });

    it('numero fora da grade e recusado pelo SERVIDOR', async () => {
      // A grade e desenhada pelo cliente; nada impede que ele envie 5000.
      const draw = await criarSorteio({ totalNumbers: 100 });
      const res = await reservar(draw.id, [150]);
      expect(res.status).toBe(400);
    });

    it('sorteio PAUSADO nao aceita reserva', async () => {
      const draw = await criarSorteio();
      await request(harness.app)
        .post(`/api/tenant/draws/${draw.id}/status`)
        .set('Cookie', cookie)
        .set('x-tenant-slug', slug)
        .send({ status: 'PAUSADA' });

      const res = await reservar(draw.id, [50]);
      expect(res.status).toBe(409);
    });

    it('reserva VENCIDA libera o numero antes de qualquer varredura', async () => {
      // O numero precisa voltar a ficar disponivel pelo RELOGIO, nao por um job
      // de limpeza: entre o vencimento e a varredura, o numero estaria preso.
      const draw = await criarSorteio();
      const primeira = await reservar(draw.id, [77]);
      expect(primeira.status).toBe(201);

      await envelhecerReserva(primeira.body.reservationId);

      const grade = await request(harness.app)
        .get(`/api/public/draws/${draw.id}/numbers`)
        .set('x-tenant-slug', slug);
      expect(
        (grade.body.taken as { number: number }[]).map((t) => t.number),
        'o 77 deveria ter voltado a ficar livre',
      ).not.toContain(77);

      const segunda = await reservar(draw.id, [77]);
      expect(segunda.status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  describe('CONCORRENCIA · o mesmo numero disputado ao mesmo tempo', () => {
    it('entre 8 requisicoes simultaneas, exatamente UMA reserva', async () => {
      // Este e o teste que justifica o indice unico. Um `SELECT` seguido de
      // `INSERT` passaria em todos os outros casos e falharia AQUI — e o defeito
      // so apareceria em producao, com duas pessoas pagando pelo mesmo numero.
      const draw = await criarSorteio();

      const tentativas = await Promise.all(
        Array.from({ length: 8 }, () => reservar(draw.id, [99])),
      );

      const criadas = tentativas.filter((r) => r.status === 201);
      const conflitos = tentativas.filter((r) => r.status === 409);

      expect(criadas, 'exatamente uma requisicao deveria vencer').toHaveLength(1);
      expect(conflitos, 'as demais deveriam receber 409').toHaveLength(7);

      // E o banco concorda: uma linha, uma dona.
      const { rows } = await harness.owner.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM draw_numbers
          WHERE draw_id = $1 AND number = 99`,
        [draw.id],
      );
      expect(rows[0]!.total).toBe('1');
    }, 120_000);

    it('lotes concorrentes que se sobrepoem nao partem ao meio', async () => {
      // [1,2,3] e [3,4,5] disputam o 3. Quem perder o 3 nao pode ficar com 4 e 5:
      // seria uma reserva parcial, que o participante nunca pediu.
      const draw = await criarSorteio();

      const [a, b] = await Promise.all([
        reservar(draw.id, [1, 2, 3]),
        reservar(draw.id, [3, 4, 5]),
      ]);

      const vencedora = [a, b].filter((r) => r.status === 201);
      expect(vencedora).toHaveLength(1);

      const { rows } = await harness.owner.query<{ number: number }>(
        `SELECT number FROM draw_numbers WHERE draw_id = $1 ORDER BY number`,
        [draw.id],
      );
      const ocupados = rows.map((r) => r.number);
      expect(ocupados, 'sobrou numero de uma reserva que falhou').toEqual(
        vencedora[0]!.body.numbers,
      );
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe('pedido e pagamento de desenvolvimento', () => {
    async function ateOPedido(numbers = [21, 22]) {
      const draw = await criarSorteio();
      const reserva = await reservar(draw.id, numbers);
      const pedido = await request(harness.app)
        .post('/api/public/orders')
        .set('x-tenant-slug', slug)
        .send({
          reservationId: reserva.body.reservationId,
          buyer: { name: 'Maria Souza', phone: '+5511999998888', email: 'maria@example.com' },
          acceptedTerms: true,
        });
      return { draw, reserva, pedido };
    }

    it('a reserva vira pedido com os numeros e o total corretos', async () => {
      const { draw, pedido } = await ateOPedido();
      expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
      expect(pedido.body.status).toBe('PENDENTE');
      expect(pedido.body.numbers).toEqual([21, 22]);
      expect(pedido.body.totalCents).toBe(draw.unitPriceCents * 2);
      expect(pedido.body.buyerName).toBe('Maria Souza');
    });

    it('sem aceite do regulamento nao ha pedido', async () => {
      const draw = await criarSorteio();
      const reserva = await reservar(draw.id, [31]);
      const res = await request(harness.app)
        .post('/api/public/orders')
        .set('x-tenant-slug', slug)
        .send({
          reservationId: reserva.body.reservationId,
          buyer: { name: 'Sem Aceite', phone: '+5511900000000' },
          acceptedTerms: false,
        });
      expect(res.status).toBe(400);
    });

    it('reserva vencida nao vira pedido', async () => {
      const draw = await criarSorteio();
      const reserva = await reservar(draw.id, [41]);
      await envelhecerReserva(reserva.body.reservationId);

      const res = await request(harness.app)
        .post('/api/public/orders')
        .set('x-tenant-slug', slug)
        .send({
          reservationId: reserva.body.reservationId,
          buyer: { name: 'Tarde Demais', phone: '+5511900000000' },
          acceptedTerms: true,
        });
      expect(res.status).toBe(409);
    });

    it('a mesma reserva nao vira dois pedidos', async () => {
      const { reserva } = await ateOPedido([51, 52]);
      const segundo = await request(harness.app)
        .post('/api/public/orders')
        .set('x-tenant-slug', slug)
        .send({
          reservationId: reserva.body.reservationId,
          buyer: { name: 'Outra Vez', phone: '+5511900000000' },
          acceptedTerms: true,
        });
      expect(segundo.status).toBe(409);
    });

    it('confirmado o pagamento, pedido e numeros ficam PAGO juntos', async () => {
      const { draw, pedido } = await ateOPedido([61, 62]);

      const pago = await request(harness.app)
        .post(`/api/dev/orders/${pedido.body.orderId}/confirm-payment`)
        .set('x-tenant-slug', slug)
        .send({});
      expect(pago.status).toBe(200);
      expect(pago.body.status).toBe('PAGO');
      expect(pago.body.paidAt).not.toBeNull();

      const grade = await request(harness.app)
        .get(`/api/public/draws/${draw.id}/numbers`)
        .set('x-tenant-slug', slug);
      const porNumero = new Map(
        (grade.body.taken as { number: number; status: string }[]).map((t) => [t.number, t.status]),
      );
      expect(porNumero.get(61)).toBe('PAGO');
      expect(porNumero.get(62)).toBe('PAGO');
    });

    it('confirmar duas vezes devolve o mesmo comprovante', async () => {
      // Um botao clicado duas vezes nao e caso excepcional.
      const { pedido } = await ateOPedido([71, 72]);
      const rota = `/api/dev/orders/${pedido.body.orderId}/confirm-payment`;
      const um = await request(harness.app).post(rota).set('x-tenant-slug', slug).send({});
      const dois = await request(harness.app).post(rota).set('x-tenant-slug', slug).send({});
      expect(um.status).toBe(200);
      expect(dois.status).toBe(200);
      expect(dois.body.paidAt).toBe(um.body.paidAt);
    });

    it('RN18 · numero PAGO nao volta para livre', async () => {
      const { draw, pedido } = await ateOPedido([81, 82]);
      await request(harness.app)
        .post(`/api/dev/orders/${pedido.body.orderId}/confirm-payment`)
        .set('x-tenant-slug', slug)
        .send({});

      // O banco recusa, mesmo pela conexao de DONO: a protecao e do esquema,
      // nao da aplicacao.
      await expect(
        harness.owner.query(
          `UPDATE draw_numbers SET status = 'RESERVADO' WHERE draw_id = $1 AND number = 81`,
          [draw.id],
        ),
      ).rejects.toThrow();

      await expect(
        harness.owner.query(`DELETE FROM draw_numbers WHERE draw_id = $1 AND number = 82`, [
          draw.id,
        ]),
      ).rejects.toThrow();
    });

    it('RN18 · so PAGO conta como vendido', async () => {
      const draw = await criarSorteio();
      await reservar(draw.id, [91, 92]); // reservado, nao vendido

      const publico = await request(harness.app)
        .get(`/api/public/draws/${draw.slug}`)
        .set('x-tenant-slug', slug);
      expect(publico.body.paidCount, 'reservado nao e venda').toBe(0);
      expect(publico.body.takenCount, 'mas ocupa a grade').toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('isolamento entre comunidades (RN01)', () => {
    it('o sorteio de A nao aparece nem e alcancavel a partir de B', async () => {
      const draw = await criarSorteio();

      const slugB = unique('outra-');
      await seedTenantWithSlug(harness.owner, slugB);

      const listaB = await request(harness.app)
        .get('/api/public/draws')
        .set('x-tenant-slug', slugB);
      expect(listaB.status).toBe(200);
      expect(listaB.body.draws.map((d: { id: string }) => d.id)).not.toContain(draw.id);

      // Nem com o identificador em maos: a RLS filtra pelo contexto, nao pelo
      // que o cliente afirma.
      const direto = await request(harness.app)
        .get(`/api/public/draws/${draw.id}/numbers`)
        .set('x-tenant-slug', slugB);
      expect(direto.status).toBe(404);

      const reservaCruzada = await request(harness.app)
        .post(`/api/public/draws/${draw.id}/reservations`)
        .set('x-tenant-slug', slugB)
        .send({ numbers: [5] });
      expect(reservaCruzada.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('o atalho de pagamento NAO existe fora do desenvolvimento', () => {
    /*
     * `POST /api/dev/orders/:id/confirm-payment` transforma um pedido em PAGO
     * sem que ninguem tenha pagado. Se essa rota responder em producao, todo o
     * controle financeiro do produto cai por uma URL.
     *
     * Os testes abaixo sobem a API com o `NODE_ENV` REAL do ambiente, em vez
     * de chamar a funcao guarda isoladamente: o que precisa recusar e a ROTA
     * montada, com os middlewares todos no lugar.
     *
     * A recusa e 404, e nao 403: 403 confirmaria que o recurso existe. Em
     * producao o endpoint nao deve nem admitir a propria existencia.
     *
     * `staging` tambem e barrado. A guarda usa lista de ambientes PERMITIDOS,
     * nao de proibidos — e a diferenca aparece aqui: barrar apenas
     * `production` teria deixado staging, qa e preview abertos por omissao.
     */
    async function tentarConfirmar(nodeEnv: 'production' | 'staging') {
      const isolado = await createHarness({ nodeEnv });
      try {
        // Identificador sintatico valido: a recusa nao pode depender de o
        // pedido existir — ela acontece antes de qualquer consulta ao banco.
        return await request(isolado.app)
          .post('/api/dev/orders/00000000-0000-4000-8000-000000000000/confirm-payment')
          .set('x-tenant-slug', slug)
          .send();
      } finally {
        await isolado.close();
      }
    }

    it('em producao, a rota se comporta como inexistente', async () => {
      const res = await tentarConfirmar('production');
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('PAGO');
    });

    it('em staging, tambem recusa', async () => {
      const res = await tentarConfirmar('staging');
      expect(res.status).toBe(404);
    });

    it('um pedido criado em producao NAO pode ser pago pelo atalho', async () => {
      // O caminho completo: pedido real, feito na bancada de teste, e depois
      // a tentativa de confirma-lo por uma API de producao. O pedido precisa
      // continuar PENDENTE.
      const draw = await criarSorteio();
      const reserva = await reservar(draw.id, [88]);
      const pedido = await request(harness.app)
        .post('/api/public/orders')
        .set('x-tenant-slug', slug)
        .send({
          reservationId: reserva.body.reservationId,
          buyer: { name: 'Nao Pagou', phone: '+5511900000000' },
          acceptedTerms: true,
        });
      expect(pedido.status).toBe(201);

      const producao = await createHarness({ nodeEnv: 'production' });
      try {
        const tentativa = await request(producao.app)
          .post(`/api/dev/orders/${pedido.body.orderId}/confirm-payment`)
          .set('x-tenant-slug', slug)
          .send();
        expect(tentativa.status).toBe(404);
      } finally {
        await producao.close();
      }

      const depois = await request(harness.app)
        .get(`/api/public/orders/${pedido.body.orderId}`)
        .set('x-tenant-slug', slug);
      expect(depois.body.status).toBe('PENDENTE');
      expect(depois.body.paidAt).toBeNull();
    });
  });
});
