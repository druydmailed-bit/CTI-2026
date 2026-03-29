# CTI 2026 - Publicacao Web

## O que foi preparado

- `index.html` continua funcionando no modo desktop/local.
- `firebase-config.js` ativa a sincronizacao web com o projeto Firebase `cti-2026`.
- `firebase-bridge.js` espelha os dados do `localStorage` no Firestore quando o app roda em `http(s)`.
- `.github/workflows/deploy-pages.yml` publica os arquivos estaticos no GitHub Pages.

## Como publicar no GitHub

1. Crie um repositorio no GitHub.
2. Envie este projeto para a branch `main`.
3. No repositorio, abra `Settings > Pages`.
4. Em `Build and deployment`, selecione `GitHub Actions`.
5. A cada push na `main`, o workflow `Deploy GitHub Pages` publicara o site.

## Como ativar o Firestore

1. No Firebase Console, abra o projeto `cti-2026`.
2. Ative `Authentication > Sign-in method > Anonymous`.
3. Ative o Cloud Firestore em modo producao ou teste.
4. Publique as regras do arquivo `firestore.rules`.
5. O app passara a sincronizar automaticamente quando rodar na web.

## Modos de uso

- `file://` ou abertura direta do `index.html`: modo desktop/local com `localStorage`.
- `http(s)://`: modo web com Firebase + fallback local.

## Observacoes

- O `firebaseConfig` do app web nao eh segredo. A seguranca real fica nas regras do Firestore.
- As seeds historicas (`seed_base_data.js` e `seed_legacy_data.js`) continuam estaticas no site, e a nuvem sincroniza os dados operacionais do app.
