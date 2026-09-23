# Validação da transição — 22/09/2026

## Configuração restaurada

O pacote privado histórico foi usado somente como fonte local para restaurar:

- conexão da API (`app_user`);
- conexões do worker/fila (`app_worker`);
- URLs administrativas usadas por CLIs;
- `MFA_ENCRYPTION_KEY` existente, sem rotação;
- CA TLS do PostgreSQL gerenciado.

Esses valores estão apenas no `.env` ignorado pelo Git.

As antigas `TEST_*_DATABASE_URL` não foram copiadas porque apontavam para o mesmo alvo físico das conexões normais. O `vitest.config.ts` agora também impede essa combinação comparando host, porta e database sem depender do usuário da URL.

As chaves Supabase de Data API/Auth históricas ficaram somente no pacote de transferência privado. O runtime atual usa PostgreSQL direto e autenticação própria; não há consumidor dessas chaves no código atual.

## Validações

- `npm run contracts:verify`: OK — 17 arquivos, digest `d9b4eed9cc723911…`;
- `npm run lint`: OK;
- `npm run typecheck`: OK;
- `npm run build`: OK;
- API compilada iniciou lendo o `.env` da raiz, com 3 origens CORS locais e seletor de tenant habilitado em desenvolvimento;
- `/api/health` respondeu com API ativa e banco indisponível nesta sandbox;
- smoke test `SELECT` das URLs históricas não chegou ao PostgreSQL por falha de resolução DNS (`EAI_AGAIN`) do ambiente de execução. Nenhuma DDL ou escrita foi executada.

## Hospedagem

Nenhum segredo foi hardcoded em `render.yaml`/Vercel. O conector disponível nesta sessão não expôs projetos Supabase e a conta Vercel conectada retornou zero projetos, então não foi possível aplicar variáveis diretamente nos painéis. O `render.yaml` continua usando `sync: false` para segredos.
