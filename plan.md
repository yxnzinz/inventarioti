# Inventário de TI — plano aprovado

## Escopo
Painel permanente da Intercargas, em português do Brasil, alimentado pela planilha enviada com 56 equipamentos e todos os campos individuais originais.

## Implementação
- `index.html`: interface responsiva, filtros combináveis, indicadores, resumo por setor expansível, analítico e exportações CSV/Excel; o botão de importação envia a base validada para a API com token.
- `data.json`: base inicial dos 56 equipamentos usada para semear o banco na primeira inicialização.
- `server.js`: Express com `GET /api/inventory/latest`, `POST /api/inventory/import` protegido por Bearer token e `GET /_app/health`.
- `inventory_state`: tabela persistente MySQL com uma versão atual da base; o arquivo do contêiner não é usado como armazenamento de produção.
- `Dockerfile` e `package.json`: execução de produção do painel híbrido.
- `manus-routes.json`: rota de página `/`; APIs não entram no manifesto de páginas.
- `dist/`: arquivos estáticos servidos pelo Express.

## API e segurança
A API de consulta é pública apenas para leitura. A importação exige `Authorization: Bearer <INVENTORY_IMPORT_TOKEN>`, valida os 16 cabeçalhos obrigatórios e mantém a base anterior quando o payload é rejeitado. O token é lido somente em runtime, via secret do projeto; nunca é enviado ao navegador junto com o HTML.

## Direção visual
Dashboard operacional editorial: navegação lateral escura, superfícies claras, verde-água proprietário para ações e estados, tipografia de alta legibilidade e tabelas densas para consulta. Interações são diretas e reversíveis: filtros recalculam todo o painel; clicar em um setor abre apenas seu detalhe contextual.

## Publicação
Serviço híbrido gerenciado pelo Webdev: Express atende a API e os arquivos estáticos, enquanto MySQL gerenciado conserva a última base válida entre reinícios e múltiplas instâncias.


## Status patrimonial
A importação aceita uma coluna opcional reconhecida como `Alugada`, `Status patrimonial`, `Status do ativo`, `Tipo de ativo`, `Propriedade` ou variações de locação. Valores textuais e `Sim/Não` em colunas de aluguel são normalizados para `Alugada` ou `De posse pessoal`. Cada máquina no detalhe por setor exibe um seletor; alterações autenticadas são persistidas pela rota `PUT /api/inventory/status` para todos os usuários.
