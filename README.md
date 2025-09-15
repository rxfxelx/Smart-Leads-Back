# Lead Finder + Validador de WhatsApp (CSV)

Aplicativo web simples que:

1. Busca telefones de empresas por **cidade/região** usando **Google Places API** (opcional).
2. **Valida** se os números possuem **WhatsApp** (via **WHAPI** – exemplo plugável).
3. Entrega a lista em **CSV** para download.

> **Atenção legal (LGPD/Termos):** Use somente dados coletados com base legal e com finalidade compatível.
> Checar números sem consentimento e disparar mensagens não solicitadas pode violar a **LGPD** no Brasil e os **Termos** de plataformas como Google e WhatsApp.
> Adapte o fluxo ao seu caso de uso, com **opt-in** e transparência. Consulte seu jurídico.

---

## Como rodar

```bash
# 1) Entre na pasta
cd lead-finder-whatsapp

# 2) Instale dependências
npm install

# 3) Configure variáveis
cp .env.example .env
# edite .env: PLACES_API_KEY, VALIDATION_PROVIDER, WHAPI_TOKEN...

# 4) Suba o servidor
npm start
# Acesse http://localhost:5173
```

---

## Provedores de validação suportados

- `WHAPI` – usa `POST /contacts` com `blocking=wait` para checar status em lote.
- `NONE` – não valida, apenas formata e exporta.

> **Meta WhatsApp Cloud API** atualmente **não expõe endpoint oficial** para verificar se um número é do WhatsApp sem tentar enviar mensagem.
> Alternativas oficiais envolvem fluxos de **opt-in** e/ou envio de **mensagem de template** (pode gerar custo e notificar o contato).

Para usar outro provedor (ex.: sua **uazapi**, 2Chat, Z-API etc), abra `server/src/whatsapp.js` e implemente uma função de validação que retorne
`[{ input: "+55...", status: "valid"|"invalid"|"unknown", wa_id: "55..."|null }]`.

---

## Fontes de contatos

A aba “Buscar por Cidade/Região” usa Google Places (Text Search + Place Details) para obter telefones públicos de estabelecimentos.
Dependendo do **uso** (ex.: criação de listas de marketing), isso **pode violar** termos do Google. Avalie usar fontes **opt-in** e bases **contratadas**.

---

## CSV

O CSV contém: `name,phone_e164,wa_status,address,source`.

---

## Estrutura

```
lead-finder-whatsapp/
├─ package.json
├─ .env.example
├─ README.md
├─ public/
│  ├─ index.html
│  └─ app.js
└─ server/
   └─ src/
      ├─ server.js
      ├─ google.js
      ├─ phone.js
      └─ whatsapp.js
```

---

## Observações de quota/limites

- Google Places **Text Search** e **Place Details** possuem cotas e **custos**. Faça cache e use filtros.
- A validação por provedores terceiros pode ter **limites** e **custos**. Lotes de até 100 contatos são recomendados.
