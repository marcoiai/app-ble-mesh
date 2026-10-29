# Level Pack — especificação normativa de produto (v0.1)

**Status:** definição arquitetural aprovada; conformidade da implementação ainda em auditoria.
**Escopo:** protocolo LevelUp / app-ble-mesh, consumido pelo Meshat. Este documento define o significado do nome **Level Pack**.

## Definição inegociável

**Level Pack não é somente a função `levelPack()` nem apenas um codec binário. Level Pack é o pipeline completo de preparação, compactação/codificação binária, proteção criptográfica autenticada, empacotamento e recuperação dos dados transportados pela rede.**

O codec binário `levelPack()/levelUnpack()` é **um componente** do Level Pack. `bodyCodec: 'lp'` sozinho **não comprova** conformidade com o Level Pack completo.

Fluxo de aplicação pretendido:

```
valor da aplicação
    -> representação compacta reversível (tokens, tipos, bytecode de dados, Level Pack)
    -> compactação adicional opcional, somente quando vantajosa (p.ex. gzip sobre binário)
    -> criptografia autenticada do payload (com chave válida)
    -> envelope versionado com informações mínimas necessárias ao roteamento
    -> transportes (BLE, LAN, Wi-Fi, WebRTC, P2P internet, gateways)
```

Na recepção: validar e autenticar criptograficamente antes de decodificar/descompactar o conteúdo; validar limites e versão; entregar valor original apenas à aplicação autorizada. Em roteadores/gateways intermediários, encaminhar a parte cifrada sem descriptografá-la. Não re-empacotar criptografia do remetente em relays.

## Política de proteção

- Mensagens de aplicação (chat, arquivos, dados de usuário, recibos, serviços, streaming quando existir): **criptografia obrigatória**, sem fallback plaintext. Sem chave adequada, falhar fechado.
- Exceções explícitas de controle de baixo conteúdo: `mesh.hello`, `mesh.ping`, `mesh.bye` podem circular em claro para descoberta e conectividade. Expor mínimo indispensável; mitigar tracking por identificadores persistentes, spoofing, replay e abuso de frequência.
- Segurança de transporte (TLS, WebRTC, rádio) não substitui cifragem do payload em nível Level Pack.
- Autenticação/chaves: especificar identidade, provisioning, rotação, armazenamento seguro e modelo de destinatários/grupos. Chave compartilhada não equivale automaticamente a E2EE individual; não embutir senha global no cliente.
- Cabeçalho usado por roteamento pode precisar permanecer legível: registrar claramente que *envelope protegido* significa payload cifrado/autenticado e metadados mínimos expostos, NÃO promessa de todos os bytes no rádio criptografados.
- Roteamento mantém dedup, TTL e anti-loop sem quebrar autenticidade. Definir campos imutáveis autenticados e campos de trânsito mutáveis separadamente antes de finalizar formato wire.

## Economia de bytes e indicadores

A codificação binária usa tags, tokens conhecidos, inteiros variáveis/zigzag e estruturas especializadas. Frequentemente reduz o tamanho de mensagens pequenas comparado a JSON; não prometer redução em **todos** os casos.

O laboratório existente `src/LevelPackBench.tsx` apresenta indicadores para os mesmos fixtures:
- **JSON (bytes)**
- **gzip (bytes)**
- **LevelPack (bytes)**
- **Winner** (menor amostra)
- **roundTrip** (perda/não perda, falha exibida no resultado).

Fixtures identificadas: `chat.say curto`, `game.input`, `game.state delta`, `mesh envelope chat`, `mesh hello`. O laboratório mede **codec binário contra JSON e gzip**, não overhead completo de criptografia/envelope. PRESERVAR esses indicadores e expandir o laboratório em vez de remover/substituir por uma métrica incompatível.

Indicadores adicionais a implementar e distinguir claramente:
1. bytes originais JSON (baseline);
2. bytes pós-codificação LP e, se aplicável, LP+gzip;
3. bytes **finais no fio**, incluindo nonce, tag de autenticação, framing, base64 e cabeçalho do envelope;
4. ganho absoluto e percentual contra baseline **na mesma unidade e amostra**;
5. custo de CPU/latência, fragmentos BLE e taxa de round-trip;
6. teste `encrypt -> decrypt -> unpack -> original`, erro ao alterar ciphertext e ao faltar chave.

Nunca comparar bytes binários de um candidato com tamanho base64 de outro sem normalização. Não confundir `Winner` do codec com resultado do pipeline criptografado.

## Mapa de implementação verificado (baseline `app-ble-mesh` b26e9c11)

- `src/mesh-core/mesh/levelpack.ts`: `levelPack`, `levelUnpack`, tags, tokenização, representações compactas.
- `src/mesh-core/mesh/compress.ts`: codecs `lp`, `lpgz`, `gzip`, seleção `packBodySmallest`.
- `src/mesh-core/mesh/secure.ts`: canal atual usa `json-transport` (gzip -> AES-GCM), em vez do fluxo integrado LP -> proteção autenticada.
- `src/mesh-core/mesh/node.ts`: integração entre geração/encaminhamento, secure, codec e transportes; observar exceções de controle.
- `src/mesh-core/mesh/levelpack-roundtrip.ts`: amostras e teste de codificação reversível.
- `src/LevelPackBench.tsx`: painel de ganhos já existente no aplicativo de testes.
- `docs/protocol/subnodes.md`: contextos locais compactos, dicionários e pontes; não é substituto do pipeline de segurança.

**Lacuna real:** as partes existem, mas o caminho cifrado da versão auditada NÃO está consolidado sobre o codec binário Level Pack; não afirmar que o comportamento normativo já está implementado. A branch de mitigação `fix/mandatory-app-envelope-encryption` restringe plaintext de aplicação, mas ainda não conclui esse contrato.

## Critérios de aceite para a consolidação

- [ ] Uma API única do pipeline Level Pack com codificação compacta e cifragem autenticada obrigatória para aplicação.
- [ ] Exceções hello/ping/bye claras e testadas; nenhuma exceção implícita por erro de compressão/cripto.
- [ ] Testes com dados reais e fixtures repetíveis mostram conteúdo legível ausente do fio.
- [ ] Prova de ida e volta e falha em chave errada/tamper/replay.
- [ ] TS e Rust interoperam na mesma versão/algoritmo e vetores.
- [ ] Relays encaminham conteúdo cifrado sem chave; dedup/TTL preservados.
- [ ] Métricas do LevelPack Lab preservadas, com bytes finais criptografados e ganho global adicionados.
- [ ] Builds e testes físicos separados por Android, macOS e Linux.

## Regra de nomenclatura

- **Level Pack:** pipeline completo.
- **Codec binário Level Pack:** componente `levelPack()/levelUnpack()`.
- **LevelPack Lab:** laboratório de métricas do codec, a evoluir para medição end-to-end.
- **Meshat:** aplicação que consome o Level Pack, não proprietária de uma implementação paralela.

Não alterar wire format nem pins de TS/Rust sem testes e migração de compatibilidade.
