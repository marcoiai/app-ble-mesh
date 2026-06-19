# Better Prompts

Contexto vivo do projeto para Codex/Claude/agents não repetirem decisões ruins.

## Fluxo De Git

- Um worktree por repo.
- `dev` é a base normal de trabalho.
- Branch nova sai de `dev`: `feat/*`, `fix/*`, `hotfix/*`.
- Não usar rebase por padrão.
- Para atualizar branch existente, usar `git fetch origin` e `git pull` conforme o fluxo do repo.
- Não misturar mudanças de outros assuntos no mesmo commit.

## app-ble-mesh E Levelup

- `levelup` foi o protótipo; `app-ble-mesh` está virando a lib/protocolo.
- O objetivo é o Levelup consumir `app-ble-mesh` como biblioteca, não copiar pedaços manualmente.
- Compilar e exportar o núcleo todo que for reutilizável, principalmente `mesh-core`.
- BLE é adapter/transporte; o núcleo deve ser transporte-agnóstico.
- Evitar “corrigir” declaração gerada com script pós-build. Se `.d.ts` sai errado, ajustar o source/tsconfig/export do pacote.

## Estado Esperado Do Mesh

- Mac<->Mac off-grid via Multipeer.
- Mac<->Android off-grid via BLE/radio.
- Droid pode atuar como central quando necessário.
- Todos os nós devem conseguir se descobrir e trocar chat/eventos.
- `chat.direct` precisa continuar entregando request/reply cross-node.
- Pixelator trafega pela malha, mas alterações nele são assunto separado.

## Cuidados

- Não remover solução que já funcionava sem confirmar no histórico/código.
- Não mexer em Gradle, Android gerado ou runtime sidecar junto com refactor de lib, salvo se for explicitamente o objetivo.
- Arquivos de workspace do VS Code são locais e não fazem parte da biblioteca.
