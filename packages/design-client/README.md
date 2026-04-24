# @funny/design-client

Frontend de **Open Design** — clon open source de Claude Design (Anthropic Labs, 2026).

Genera prototipos visuales interactivos a partir de prompts en lenguaje natural y los entrega como bundles ejecutables a `funny` (o cualquier agente compatible con Claude Code).

## Estado

🚧 En diseño — ver [docs/open-design.md](./docs/open-design.md) para la especificación completa.

## Decisiones técnicas clave

- **Output:** HTML + Tailwind (no React, no JSON intermedio)
- **Edición:** HAST (Hypertext AST de unified/rehype) + JSONPatch (RFC 6902)
- **Sandbox:** iframe `srcdoc` con CSP estricta
- **Multiplayer:** turn-based en MVP; Yjs/CRDT post-MVP
- **Sliders:** mutan CSS variables sin re-prompt al LLM

Ver [docs/decisions.md](./docs/decisions.md) para el detalle de cada decisión.
