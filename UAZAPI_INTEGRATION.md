# Integração com UAZAPI (verificação de WhatsApp)

## O que você precisa obter com o suporte UAZ
1. **Base URL da sua instância** (ex.: `https://seu-servidor.uazapi.dev`).  
2. **Nome da instância** (ex.: `minhaInstancia`).  
3. **API Key** da instância (header `apikey`).  
4. **Rota de verificação** (ex.: `/contacts/check` ou similar).  

> O Postman público da UAZ mostra o uso de **header `apikey`** e rotas que incluem o **nome da instância** no path. citeturn1view0

## Como configurar no projeto
Defina as variáveis:
```
VALIDATION_PROVIDER=UAZAPI
UAZ_BASE_URL=https://seu-servidor.uazapi.dev
UAZ_INSTANCE=minhaInstancia
UAZ_API_KEY=seu_api_key
UAZ_VERIFY_PATH=/contacts/check   # ajuste conforme a sua rota real
```

## Como a chamada é feita aqui
O código (em `app/verify.py`) tenta automaticamente:
1) `POST {BASE}{PATH}/{INSTANCE}` com JSON:  
```json
{"phones": ["+5511999999999", "+5531999999999"]}
```
2) (fallback) `POST {BASE}{PATH}` com JSON:  
```json
{"instance":"minhaInstancia","phones":["+5511999999999"]}
```

### Formatos de resposta aceitos
- **Lista de resultados**  
  ```json
  {"results":[{"phone":"+5511999999999","exists":true}]}
  ```
- **Lista com `is_whatsapp`**  
  ```json
  {"data":[{"phone":"+5511999999999","is_whatsapp":true}]}
  ```
- **Unitário**  
  ```json
  {"success": true, "status": "valid"}
  ```

Se sua resposta for diferente, adapte facilmente a função `verify_uazapi` (bloco `parse_and_fill`).

## Exemplo de cURL
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "apikey: SEU_API_KEY" \
  -d '{"phones":["+5531999999999"]}' \
  https://seu-servidor.uazapi.dev/contacts/check/minhaInstancia
```

## Notas
- Consulte sua equipe UAZ para o endpoint correto de **verificação de número** (a coleção pública do Postman cobre autenticação e padrão de URL com `apikey` + `instância`). citeturn1view0
- Se preferir, me envie **exatamente** o caminho do endpoint e um **exemplo de resposta**, que eu ajusto prontinho aqui.
