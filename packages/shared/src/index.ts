// Contratos, estados, permissoes e constantes. Esta arvore e a FONTE: o
// frontend carrega uma copia conferida por hash (CONTRACTS_SNAPSHOT.json).
//
// Os helpers de apresentacao (`src/frontend`) e os estilos vivem no repositorio
// de frontend — o servidor nao formata moeda nem monta URL de vitrine, e
// arrasta-los para ca so aumentaria a superficie que precisa ficar identica
// dos dois lados.
export * from './constants/index.js';
export * from './states/index.js';
export * from './permissions/index.js';
export * from './contracts/index.js';
