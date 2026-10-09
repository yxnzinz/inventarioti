

## Setor ALUGUEL
A nova BASE COMPLETA contém 66 equipamentos, incluindo 10 registros numerados de 57 a 66 marcados como `ALUGADO`. Esses registros são normalizados para o setor `ALUGUEL`, permanecem com status patrimonial `Alugada` e são adicionados à base persistente sem duplicação. Futuras importações também convertem automaticamente `ALUGADO`, `ALUGADA` ou `ALUGUEL` para `ALUGUEL`.

## Número de patrimônio
A coluna `Patrimônio/Pessoal/Alugado` é lida durante a importação. Números em formatos como `ALUGUEL/N°Patrimônio: 533` ou em uma coluna separada são extraídos para o campo `Patrimônio`, exibido ao lado da RAM no detalhe da máquina e incluído nas exportações. O parser aceita números isolados e continuará preenchendo novos lotes em futuras planilhas.
