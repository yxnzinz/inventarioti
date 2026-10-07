# Inventário de TI — plano aprovado

## Escopo
Painel permanente da Intercargas, em português do Brasil, alimentado pela planilha enviada com 56 equipamentos e todos os campos individuais originais.

## Implementação
- `index.html`: interface responsiva, filtros combináveis, indicadores, resumo por setor expansível, analítico e exportações CSV/Excel.
- `data.json`: base normalizada dos 56 equipamentos extraída da aba `BASE COMPLETA`.
- `manus-routes.json`: rota única `/` para o painel.
- `dist/`: cópia estática usada pela publicação.

## Direção visual
Dashboard operacional editorial: navegação lateral escura, superfícies claras, verde-água proprietário para ações e estados, tipografia de alta legibilidade e tabelas densas para consulta. Interações são diretas e reversíveis: filtros recalculam todo o painel; clicar em um setor abre apenas seu detalhe contextual.

## Publicação
Serviço estático gerenciado pelo Webdev, sem banco ou servidor de aplicação: a fonte é a planilha incorporada no artefato estático; exportações são geradas no navegador conforme os filtros ativos.
