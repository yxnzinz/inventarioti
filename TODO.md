# Entregas

- Publicar um painel permanente da Intercargas alimentado pelos 56 equipamentos e todos os campos individuais da planilha.
- Disponibilizar filtros combináveis por semana de coleta, setor e sistema operacional, recalculando os indicadores conforme o recorte.
- Exibir resumo por setor com totais consolidados e permitir clicar/expandir cada setor para ver suas máquinas individuais.
- Exibir analítico contextualizado por setor, incluindo quantidade, sistemas operacionais, RAM total e disco médio.
- Exibir tabela detalhada dos equipamentos com os campos originais preservados.
- Permitir exportar as linhas filtradas em CSV e Excel.
- Disponibilizar `GET /api/inventory/latest` para todos os usuários carregarem a base persistente atual.
- Disponibilizar `POST /api/inventory/import` protegido por Bearer token, validando a estrutura antes de substituir a base.
- Persistir a base atual em banco gerenciado e manter a versão anterior quando uma importação for rejeitada.
- Adaptar o botão Importar XLSX para enviar a base validada à API e atualizar todos os usuários.
- Adicionar a subaba Visão executiva na sidebar, com indicadores gerenciais, gráficos por setor e status patrimonial, alertas automáticos, leitura de infraestrutura e modo apresentação, mantendo a página principal operacional.
- Redefinir a identidade cromática de todo o site a partir do logotipo Intercargas: azul celeste `#2f77ad` para ações e nomes de setores, azul profundo para títulos/sidebar/textos institucionais, vermelho `#c53a3e` para alertas e acentos, fundos azulados claros e estados interativos com contraste legível.
