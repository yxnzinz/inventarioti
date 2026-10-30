

## Setor BACKUP
O equipamento nº 67 da nova BASE COMPLETA é classificado no setor `BACKUP`, com responsável BRUNO, Windows 11, 16 GB de RAM e 512 GB de disco. Novos registros de setores também são incorporados automaticamente à base persistente quando entram na base inicial atualizada.

## Refinamento visual corporativo
A paleta segue a direção aprovada de **azul-marinho + laranja**: o azul-marinho sustenta navegação, texto e superfícies institucionais; o laranja identifica ações, destaques, indicadores e pontos de atenção; fundos claros e cinzas suaves preservam a leitura executiva. A tipografia Aptos/Inter permanece com hierarquia compacta e corporativa, e o laranja é aplicado com contraste suficiente para não transformar todos os elementos em alerta.

## Redesign visual baseado no logotipo Intercargas
A interface adota a linguagem cromática observada no logotipo fornecido: **azul celeste da marca** para navegação, ações e nomes de setores; **azul profundo** para títulos, textos institucionais e a sidebar; e **vermelho Intercargas** para alertas, pontos de atenção e acentos de destaque. Fundos azulados muito claros, bordas frias e sombras suaves deixam o dashboard mais leve, corporativo e legível.

- **Movimento:** dashboard executivo de logística, com estética de painel operacional confiável e acabamento institucional.
- **Princípios:** hierarquia nítida, contraste funcional, cor com significado e superfícies arejadas.
- **Layout:** sidebar como âncora de marca e conteúdo principal em cartões claros, com acentos cromáticos controlados.
- **Elementos de assinatura:** azul celeste nos controles acionáveis, vermelho nos alertas e cabeçalhos/estados em azul profundo.
- **Interação:** botões e itens clicáveis devem parecer operacionais e previsíveis; hover usa variações mais profundas do azul sem deslocar a leitura.
- **Animação:** transições curtas e discretas apenas em hover, foco, seleção e expansão de setores.
- **Tipografia:** Aptos/Inter, títulos em azul profundo, rótulos compactos e métricas com peso alto.
- **Essência da marca:** controle de inventário para uma operação logística que precisa decidir rápido, com rastreabilidade e clareza. Personalidade: confiável, objetiva e conectada.
- **Tom de voz:** direto e executivo; exemplos: “Recorte de análise” e “Leitura rápida da composição, cobertura e pontos de atenção”.
- **Marca:** a sidebar conserva a lógica de um bloco institucional; o contraste azul-vermelho remete ao logotipo sem inserir a imagem com watermark na interface.
- **Cor proprietária:** azul celeste `#2f77ad`, inspirado no azul dominante do logotipo.

## Prévia segura de importação XLSX
A seleção do arquivo não grava dados. O navegador valida a aba `BASE COMPLETA`, reconhece as colunas, normaliza status e patrimônio, compara a planilha com a base atual por número do equipamento/hostname e apresenta linhas, colunas reconhecidas, novos, alterados, removidos, avisos, erros e patrimônios duplicados. A atualização para todos só ocorre após o usuário revisar a prévia e confirmar com o token de importação.

## Camada operacional complementar
O painel passa a oferecer pesquisa rápida por campos do equipamento, ficha detalhada em modal, status operacional independente da classificação patrimonial, histórico persistente de importações e alterações de status, relatório executivo imprimível/salvável em PDF respeitando os filtros ativos.

## Acesso por perfil e gerenciador interno de usuários
O acesso será feito por **login interno**, sem depender de contas reais no Manus ou na internet. O backend armazenará usuários, senhas derivadas com `scrypt` e sessões opacas no banco gerenciado. O cookie `webdev_app_session` será `HttpOnly`, `Secure` e `SameSite=None` no domínio HTTPS publicado, mantendo tratamento local separado para desenvolvimento.

- No primeiro acesso, o sistema permitirá criar o primeiro usuário Administrador; depois disso, somente Administradores poderão criar novos usuários.
- O Gerenciador de usuários será uma subaba da sidebar, visível apenas para Administradores, com cadastro, edição de nome/e-mail interno, perfil, senha, ativação/desativação e exclusão.
- Os perfis serão `Administrador` e `Visualizador`. Administradores poderão importar computadores, infraestrutura e outra filial, alterar status/classificação e gerenciar usuários; Visualizadores poderão consultar, filtrar, abrir fichas, gerar relatórios e exportar dados, sem mutações.
- E-mails internos podem ser fictícios ou não existir fora da empresa; eles funcionarão como identificadores de login no próprio sistema.
- A autorização será aplicada também no backend: consultas exigem sessão; mutações e endpoints de usuários exigem perfil Administrador; importações continuam protegidas pelo token de importação.
- O login terá estado visível no cabeçalho, botão de saída, mensagens de erro e tela de acesso bloqueado enquanto não houver sessão válida.
