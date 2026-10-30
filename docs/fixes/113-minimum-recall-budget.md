# Minimum recall budget (#113)

A complete fact shorter than 120 characters can fit the remaining space without the old fixed 120-character headroom test. The historical trust envelope is unchanged. Units that cannot fit are skipped so smaller eligible facts can still be considered; if no eligible unit fits, the manifest explicitly reports a budget-too-small reason rather than a header-only block. Tokens remain an estimate (three UTF-16 code units per token), not backend tokenizer accounting.
