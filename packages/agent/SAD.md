# Agent Pipeline: Sistema Distribuido de Calidad para Software

## Resumen Ejecutivo

Este documento define un **Pipeline Service** — un servicio independiente de calidad de software basado en agentes de IA. El Service expone un REST API. Cualquier servicio web, CLI, o sistema externo puede hacer HTTP requests para enviar worktrees a procesar. El Service se encarga de todo: recibir la rama, ejecutar 8 agentes de calidad en paralelo, auto-corregir problemas, y notificar los resultados via webhooks.

La arquitectura sigue el patron **Hexagonal (Ports & Adapters)**. El Core define contratos claros de entrada y salida. El Service encapsula toda la complejidad — adapters, Event Bus, Director, Integrador — en un solo proceso. Los clientes externos no spawnean procesos, no gestionan agentes, no saben como funciona internamente.

Un Agente Director coordina multiples pipelines simultaneos. Un Agente de Integracion toma las ramas aprobadas, crea Pull Requests hacia main con resumen completo de resultados, resuelve conflictos y deduplica codigo. El merge final a main requiere aprobacion humana via PR.

La diferencia fundamental con un CI/CD tradicional: **este sistema no solo detecta problemas, los arregla. Y no solo arregla uno — coordina muchos en paralelo. Y no esta acoplado a ninguna herramienta — se conecta a cualquiera.**

---

## 1. Arquitectura General: Pipeline Service

El sistema completo es un **Pipeline Service** — un servicio independiente que corre por su cuenta. Cualquier servicio web puede enviarle worktrees a procesar via HTTP. No spawnea procesos, no gestiona agentes, no sabe como funciona el pipeline internamente. Solo envia un request y recibe notificaciones.

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                   │
│                              PIPELINE SERVICE (servicio independiente)                             │
│                              Corre por su cuenta. Nadie lo "levanta" por request.                 │
│                                                                                                   │
│   ┌─────────────────┐     ┌───────────────────────────────┐     ┌──────────────────────────────┐  │
│   │ INBOUND          │     │                               │     │ OUTBOUND                      │  │
│   │                  │     │       PIPELINE CORE            │     │                              │  │
│   │ REST API         │     │                               │     │  Manifest Writer             │  │
│   │ POST /pipeline   │────►│  Recibe PipelineRequest       │────►│  Webhook Notifier → HTTP POST│───► Cliente
│   │ POST /director   │     │  Clasifica tier               │     │  Slack Notifier  → Webhook   │───► Slack
│   │                  │     │  Levanta containers (Paso 0)  │     │  GitHub Notifier → gh API    │───► GitHub
│   │ CLI              │     │  Crea browser (Playwright)    │     │                              │  │
│   │ pipeline run ... │────►│  Crea rama pipeline/          │     │                              │  │
│   │                  │     │  Corre 8 agentes (con browser)│     │                              │  │
│   │ MCP Server       │     │  Auto-corrige                 │     │  Solo reacciona a eventos    │  │
│   │ tool: run_pipe.. │────►│  Emite PipelineEvent[]        │     │  No sabe que es el Core      │  │
│   │                  │     │                               │     │                              │  │
│   └─────────────────┘     └───────────────┬───────────────┘     └──────────────────────────────┘  │
│                                            │                                                      │
│                                      ┌─────┴─────┐                                                │
│                                      │ EVENT BUS │                                                │
│                                      │           │                                                │
│                                      │ Conecta   │                                                │
│                                      │ Core con  │                                                │
│                                      │ Outbound  │                                                │
│                                      └───────────┘                                                │
│                                                                                                   │
│   ┌─────────────────┐     ┌──────────────────────────┐     ┌──────────────────────────────────┐   │
│   │ DIRECTOR         │     │ INTEGRADOR               │     │ INFRAESTRUCTURA                   │   │
│   │                  │     │                          │     │                                  │   │
│   │ Lee manifest     │────►│ Crea PR hacia main       │     │  SandboxManager (Podman, OBLIG.) │   │
│   │ Reacciona a      │     │ Resuelve conflictos      │     │  ContainerService (compose, OPC.)│   │
│   │ eventos          │     │ Deduplica                │     │  CDP Browser (Playwright)        │   │
│   └─────────────────┘     └──────────────────────────┘     │  Circuit Breakers, DLQ, Idem.    │   │
│                                                             └──────────────────────────────────┘   │
│                                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘

        ▲                         ▲                         ▲
        │ HTTP POST               │ HTTP POST               │ Webhook
        │ (fire & forget)         │ (fire & forget)         │ (recibe eventos)
        │                         │                         │
   Servicio web              GitHub                   Slack / Jira / etc.
   (cualquiera)              (webhooks)               (reciben notificaciones)
```

### El Pipeline Service es autonomo

El Pipeline Service:
- **Corre como un servicio** — Se levanta una vez, escucha requests. No se "spawna por request".
- **Expone un REST API** — Los clientes externos solo hacen HTTP POST. Reciben `202 Accepted` y listo.
- **Gestiona todo internamente** — Adapters, Core, Event Bus, Director, Integrador, Containers, Browser. Todo vive dentro.
- **Levanta infraestructura obligatoria** — **Siempre** crea un sandbox container Podman para cada pipeline (requisito obligatorio — sin Podman el pipeline falla). Los archivos del worktree se copian al container y se inicializa un repo git fresco. Adicionalmente, si el proyecto tiene `compose.yml`, levanta containers de proyecto y un browser (Playwright CDP). Si no hay compose, continua sin containers de proyecto pero el sandbox siempre existe.
- **Notifica via outbound** — Cuando algo pasa, los outbound adapters llaman a los clientes registrados via webhooks.

### Lo que un cliente externo necesita hacer

| Cliente | Para disparar | Para recibir resultados |
|---|---|---|
| **Cualquier servicio web** | `POST /pipeline/run` con branch + worktree_path + metadata | Exponer un endpoint webhook para recibir eventos |
| **GitHub** | Configurar webhook apuntando al Pipeline Service | El Service comenta en PRs automaticamente |
| **CLI** | `pipeline run --branch feature/auth` | Ve el output en la terminal |
| **Otro agente** | MCP tool `run_pipeline` | Recibe resultado via MCP |

**Ningun cliente spawna procesos, gestiona agentes, ni sabe como funciona el pipeline.** Solo hacen HTTP requests y exponen endpoints para recibir notificaciones.

### Por que esta arquitectura

1. **Independencia** — El Service es un proceso autonomo. Los clientes no necesitan tener Claude Code instalado, ni saber de agentes, ni de Git.
2. **Simplicidad para clientes** — Un servicio web solo hace un POST y expone un endpoint para webhooks. Nada mas.
3. **Extensibilidad** — Agregar un nuevo destino de notificacion (Discord, Jira, email) es agregar un outbound adapter dentro del Service. Cero cambios al Core, cero cambios a los clientes existentes.
4. **Testeabilidad** — El Service se testea como un servicio HTTP normal. Los clientes se testean independientemente.
5. **Deployment** — Un solo servicio que deployar. Los clientes no cambian su infraestructura.

---

## 2. Los Cuatro Niveles del Sistema

### Nivel 0: Pipeline Service (HTTP API)

El Pipeline Service es un servidor HTTP que corre permanentemente. Expone un REST API que cualquier cliente puede llamar. Un servicio web hace `POST /pipeline/run` con los datos del worktree a procesar y recibe notificaciones via webhooks o SSE. No spawna nada, no gestiona nada.

### Nivel 1: Pipeline Core (Infraestructura + Ejecucion + Validacion)

Dentro del Service, el Core recibe un `PipelineRequest`, clasifica el tier del cambio, y ejecuta un **Paso 0 de infraestructura**: **siempre** crea un sandbox container Podman donde corre el agente (requisito obligatorio). Los archivos del worktree se copian al container y se inicializa un repositorio git fresco via `git clone --no-checkout`. Opcionalmente, si el worktree tiene un `compose.yml`, tambien levanta containers de proyecto, espera health checks, y crea un browser headless (Playwright CDP) con herramientas MCP (`cdp_navigate`, `cdp_screenshot`, `cdp_get_dom`). Luego crea la rama de pipeline (`pipeline/{branch}`), ejecuta los 8 agentes de calidad en paralelo — con acceso a browser si hay containers de proyecto — auto-corrige si es necesario, y emite eventos con los resultados (incluyendo `pipeline.cli_message` con cada mensaje raw del agente para renderizado en la UI). Al finalizar, limpia sandbox, containers de proyecto, y browser. Es completamente stateless — no guarda estado entre ejecuciones.

### Nivel 2: Director (Coordinacion)

El Director lee el manifiesto (`.pipeline/manifest.json`) para saber que ramas estan listas. Reacciona a eventos `pipeline.completed` para saber cuando hay trabajo nuevo. Resuelve dependencias entre ramas, ordena por prioridad, y despacha al Integrador.

### Nivel 3: Integrador (Merge)

El Integrador toma ramas aprobadas y **crea Pull Requests hacia main**. Prepara la rama, resuelve conflictos semanticamente, deduplica codigo, re-ejecuta el pipeline sobre el resultado, y abre un PR con el resumen completo de los agentes. El merge final a main requiere aprobacion humana.

---

## 3. El Contrato del Pipeline Core

El Core solo entiende un lenguaje. No sabe quien lo llamo ni a donde van los resultados. Solo sabe recibir un `PipelineRequest` y emitir `PipelineEvent`.

### 3.1 PipelineRequest (Input)

Es lo unico que el Core necesita para arrancar. Cualquier adapter debe traducir su request a este formato.

```json
{
  "request_id": "uuid-v4",
  "branch": "feature/auth",
  "worktree_path": "/absolute/path/to/worktree",
  "base_branch": "main",
  "config": {
    "create_pipeline_branch": true,
    "auto_correct": true,
    "max_correction_attempts": 3,
    "tier_override": null,
    "agents": {
      "tests":         { "enabled": true,  "blocking": true },
      "security":      { "enabled": true,  "blocking": true },
      "architecture":  { "enabled": true,  "blocking": true },
      "performance":   { "enabled": true,  "blocking": false },
      "dependencies":  { "enabled": true,  "blocking": true },
      "code_quality":  { "enabled": true,  "blocking": false },
      "accessibility": { "enabled": true,  "blocking": "conditional" },
      "documentation": { "enabled": true,  "blocking": false }
    }
  },
  "metadata": {
    "triggered_by": "my-app",
    "task_id": "TASK-123",
    "callback_url": "https://my-app.com/api/webhooks/pipeline",
    "custom": {}
  }
}
```

**Campos clave:**

| Campo | Obligatorio | Descripcion |
|---|---|---|
| `request_id` | Si | Identificador unico de esta ejecucion. Lo generan los adapters. |
| `branch` | Si | La rama sobre la que se ejecuta el pipeline. |
| `worktree_path` | Si | Path absoluto al worktree donde esta el codigo. |
| `base_branch` | No | Rama base para comparar cambios. Default: `main`. |
| `config` | No | Sobreescribe la configuracion por defecto del proyecto (`.pipeline/config.yaml`). Si no se envia, usa la del proyecto. Incluye `tier_override` para forzar un tier ("small", "medium", "large") en vez de la clasificacion automatica. |
| `metadata` | No | Datos opacos para el Core. Se pasan tal cual en los eventos de salida. Los clientes y adapters los usan para correlacionar (ej: `task_id` para saber que entidad actualizar en el cliente). |

**Nota sobre `metadata`:** El Core no lee, no interpreta, no valida `metadata`. Lo recibe y lo incluye en cada evento que emite. Es responsabilidad de los outbound adapters interpretarlo. Esto mantiene al Core completamente desacoplado.

### 3.2 PipelineEvent (Output)

El Core emite eventos a traves del Event Bus. Cada evento tiene un tipo, un timestamp, el `request_id` para correlacionar, y datos especificos.

```json
{
  "event_type": "pipeline.agent.completed",
  "request_id": "uuid-v4",
  "timestamp": "2026-02-14T12:01:30Z",
  "data": { ... },
  "metadata": { "triggered_by": "my-app", "task_id": "TASK-123", "callback_url": "..." }
}
```

### Catalogo completo de eventos

**Nota:** Este es el catalogo conceptual del SAD. La implementacion real tiene un catalogo ligeramente diferente — ver Apendice §A.9 y §A.13 para las diferencias.

| Evento | Cuando se emite | Data |
|---|---|---|
| `pipeline.accepted` | El Service acepto el request (antes de clasificar tier) | `{ branch, worktree_path }` |
| `pipeline.tier_classified` | Tier clasificado via git diff --stat | `{ tier, stats }` |
| `pipeline.started` | El agente Claude inicio (session init) | `{ session_id, model }` |
| `pipeline.containers.ready` | Sandbox listo, y opcionalmente containers de proyecto + browser | `{ worktree_path, has_browser }` |
| `pipeline.agent.started` | Un sub-agente (Task tool) fue lanzado | `{ tool_use_id, agent_name, input }` |
| `pipeline.agent.completed` | Un agente individual termino | `{ agent, status, details, duration_ms }` |
| `pipeline.correcting` | Se detecto un ciclo de correccion en el texto del agente | `{ correction_number, text }` |
| `pipeline.cli_message` | Cada CLIMessage raw del agente (para renderizado en la UI) | `{ cli_message }` |
| `pipeline.completed` | Pipeline termino exitosamente (todos los bloqueantes pasan) | `{ result, duration_ms, num_turns, cost_usd, corrections_count, branch, tier, corrections_applied }` |
| `pipeline.failed` | Pipeline fallo (agente error, intentos agotados, o error inesperado) | `{ error, result, duration_ms, cost_usd, corrections_count }` |
| `pipeline.stopped` | Pipeline detenido manualmente (POST /:id/stop) | `{}` |

### Ejemplo de secuencia de eventos

```
→ pipeline.accepted          { branch: "feature/auth", worktree_path: "/path/to/worktree" }
→ pipeline.tier_classified   { tier: "large", stats: { files: 12, lines: 390 } }
→ pipeline.containers.ready  { worktree_path: "/path/to/worktree", has_browser: true }
→ pipeline.started           { session_id: "sess-xxx", model: "sonnet" }
→ pipeline.cli_message       { cli_message: { type: "system", subtype: "init", ... } }
→ pipeline.agent.started     { tool_use_id: "tu_1", agent_name: "Task", input: {...} }
→ pipeline.cli_message       { cli_message: { type: "assistant", ... } }  (muchos de estos)
→ pipeline.agent.started     { tool_use_id: "tu_2", agent_name: "Task", input: {...} }
→ ...
→ pipeline.correcting        { correction_number: 1, text: "Re-running failing agents..." }
→ pipeline.agent.started     { tool_use_id: "tu_9", agent_name: "Task", input: {...} }
→ ...
→ pipeline.completed         { result: "...", duration_ms: 180000, num_turns: 45, cost_usd: 2.5, corrections_count: 1, branch: "feature/auth", tier: "large", corrections_applied: ["security: token expiration"] }
```

**Nota:** Los eventos `pipeline.cli_message` son los mas frecuentes — uno por cada CLIMessage del agente (tool calls, bash output, texto del asistente, etc.). Se usan para renderizado en la UI via el ingest webhook. Los eventos de lifecycle (`started`, `completed`, `correcting`, etc.) son mucho menos frecuentes.

---

## 4. El Event Bus

El Event Bus es el sistema nervioso que conecta el Core con los adapters. Es el unico punto de contacto — el Core publica eventos, los adapters los escuchan.

### Responsabilidades

1. **Recibir eventos** del Pipeline Core
2. **Distribuir eventos** a todos los outbound adapters suscritos
3. **Persistir eventos** opcionalmente en `.pipeline/events/` para auditoria y replay
4. **Garantizar entrega** — si un adapter falla, el evento no se pierde

### Implementacion

El Event Bus puede ser tan simple o complejo como se necesite, dependiendo del contexto de deployment:

| Contexto | Implementacion | Descripcion |
|---|---|---|
| **Maquina local** | EventEmitter (Node.js) | Pub/sub en memoria. Simple, rapido, sin dependencias. |
| **Maquina local + persistencia** | EventEmitter + archivos JSON | Cada evento se escribe en `.pipeline/events/{request_id}.jsonl`. Permite replay y auditoria. |
| **Multiples maquinas** | Redis Pub/Sub | Eventos se distribuyen entre maquinas. Los adapters pueden correr en diferentes servers. |
| **Enterprise** | Message queue (RabbitMQ, NATS) | Garantias de entrega, dead letter queues, routing avanzado. |

### Persistencia de eventos

Cada ejecucion del pipeline genera un archivo de eventos en `.pipeline/events/`:

```
.pipeline/
├── events/                              # O ruta personalizada via config.events.path
│   ├── abc-123.jsonl                    # Eventos del pipeline abc-123
│   ├── def-456.jsonl                    # Eventos del pipeline def-456
│   └── ...
├── manifest.json
└── config.yaml
```

**Nota:** Los eventos se almacenan por `request_id` (no por fecha/branch). La ruta de persistencia es configurable via `config.events.path` o via la variable de entorno `EVENTS_PATH` (default: `~/.a-parallel/pipeline-events`).

Cada archivo `.jsonl` contiene un evento por linea, en orden cronologico:

```jsonl
{"event_type":"pipeline.accepted","request_id":"abc-123","timestamp":"2026-02-14T12:00:00Z","data":{"branch":"feature/auth","worktree_path":"/path/to/worktree"}}
{"event_type":"pipeline.tier_classified","request_id":"abc-123","timestamp":"2026-02-14T12:00:00.1Z","data":{"tier":"large","stats":{"files":12,"lines":390}}}
{"event_type":"pipeline.containers.ready","request_id":"abc-123","timestamp":"2026-02-14T12:00:02Z","data":{"worktree_path":"/path/to/worktree","has_browser":true}}
...
```

**Beneficios de la persistencia:**

1. **Auditoria** — Se puede reconstruir exactamente que paso en cada pipeline
2. **Replay** — Si un outbound adapter fallo, se puede re-procesar el archivo de eventos
3. **Debugging** — Cuando algo sale mal, el historial de eventos cuenta la historia completa
4. **Metricas** — Se puede analizar duracion, tasa de fallo, agentes mas lentos, etc.

---

## 4b. Sistema de Logging

El Event Bus maneja la comunicacion entre componentes. El sistema de logging es diferente: es un **registro completo de todo lo que pasa** — cada accion de cada agente, cada comando git, cada llamada a GitHub, cada decision del Director. Es la caja negra del sistema.

### Diferencia entre eventos y logs

| | Eventos (Event Bus) | Logs |
|---|---|---|
| **Proposito** | Comunicacion entre componentes | Observabilidad y debugging |
| **Granularidad** | Alto nivel (`pipeline.completed`) | Detallado (`agent security scanning auth.ts line 45`) |
| **Quien los consume** | Outbound adapters, Director | Humanos, dashboards, alertas |
| **Formato** | PipelineEvent (tipado) | Log entry (estructurado pero flexible) |

### Formato del log

Cada entrada es JSON estructurado con campos fijos:

```json
{
  "timestamp": "2026-02-14T12:00:01.234Z",
  "level": "info",
  "source": "core.agent.security",
  "request_id": "abc-123",
  "action": "scan.file",
  "message": "Scanning auth.ts for vulnerabilities",
  "data": {
    "file": "src/auth.ts",
    "lines_scanned": 145,
    "vulnerabilities_found": 1
  },
  "duration_ms": 3200
}
```

**Campos fijos:**

| Campo | Descripcion |
|---|---|
| `timestamp` | Momento exacto (milisegundos) |
| `level` | `debug` / `info` / `warn` / `error` / `fatal` |
| `source` | Componente que genero el log (ver tabla abajo) |
| `request_id` | Correlacion — todas las entradas de un pipeline comparten el mismo ID. `null` para logs de sistema. |
| `action` | Accion especifica que se ejecuto |
| `message` | Descripcion legible |
| `data` | Datos estructurados especificos de la accion |
| `duration_ms` | Duracion de la accion (si aplica) |

### Sources (componentes que loggean)

| Source | Que loggea | Ejemplos |
|---|---|---|
| `inbound.rest` | Requests HTTP entrantes | `POST /pipeline/run recibido`, `202 Accepted enviado` |
| `inbound.cli` | Comandos CLI | `pipeline run --branch feature/auth` |
| `core.pipeline` | Operaciones del pipeline | `Pipeline iniciado`, `Tier clasificado: medium`, `Pipeline completado` |
| `core.agent.tests` | Agente de pruebas | `Ejecutando test suite`, `25/25 tests passed`, `Test auth.spec.ts failed` |
| `core.agent.security` | Agente de seguridad | `Scanning auth.ts`, `Vulnerabilidad encontrada: token sin expiracion` |
| `core.agent.architecture` | Agente de arquitectura | `Evaluando acoplamiento`, `SOLID violation en UserService` |
| `core.agent.performance` | Agente de performance | `Detectado O(n^2) en utils.ts:45` |
| `core.agent.dependencies` | Agente de dependencias | `Auditando 45 dependencias`, `CVE-2026-1234 en lodash` |
| `core.agent.code_quality` | Agente de code quality | `Analizando consistencia`, `Duplicacion detectada` |
| `core.agent.accessibility` | Agente de accesibilidad | `Skipped: sin cambios UI`, `WCAG AA violation` |
| `core.agent.documentation` | Agente de documentacion | `README desactualizado`, `Docstring faltante` |
| `core.correction` | Auto-correccion | `Intento 1/3 para security`, `Fix aplicado`, `Commit creado` |
| `core.containers` | Infraestructura: sandbox obligatorio + containers de proyecto + browser | `Sandbox container started`, `compose.yml detectado`, `Containers levantados`, `Health check passed`, `CDP browser listo` |
| `director` | Decisiones del Director | `Manifest leido: 2 ready`, `Rama elegible`, `Despachando al Integrador` |
| `integrator` | Operaciones del Integrador | `Creando rama integration/`, `PR #42 creado`, `Rebase de PR stale` |
| `git` | Cada comando git ejecutado | `git checkout -b pipeline/feature/auth`, `git merge --no-ff`, `git push` |
| `github` | Cada llamada a GitHub API | `gh pr create → #42`, `gh pr comment`, `Webhook recibido: PR merged` |
| `adapter.outbound.webhook` | Webhooks enviados | `POST al cliente → 200 OK`, `POST al cliente → timeout → DLQ` |
| `adapter.outbound.slack` | Notificaciones Slack | `Mensaje enviado a #dev` |
| `adapter.outbound.manifest` | Escritura al manifiesto | `Rama agregada a ready[]`, `Movida a pending_merge[]` |
| `event-bus` | Publicacion de eventos | `Evento pipeline.completed publicado`, `3 suscriptores notificados` |
| `saga` | Transacciones | `Paso create_branch completado`, `Compensacion ejecutada` |
| `circuit-breaker` | Estado de circuits | `GitHub API circuit OPEN`, `Circuit reset a CLOSED` |
| `dlq` | Dead letter queue | `Evento encolado para retry`, `Retry 3/5 exitoso` |

### Niveles de log

| Nivel | Cuando se usa | Ejemplo |
|---|---|---|
| `debug` | Detalles granulares, solo para desarrollo | `Scanning line 45 of auth.ts` |
| `info` | Operaciones normales, flujo esperado | `Pipeline iniciado para feature/auth` |
| `warn` | Algo inesperado pero no fatal | `Performance warning: O(n^2)`, `Retry 2/5 para webhook` |
| `error` | Fallo que requiere atencion | `Agent security fallo`, `PR creation fallo`, `Circuit breaker OPEN` |
| `fatal` | El sistema no puede continuar | `Claude Code no disponible`, `Filesystem read-only` |

### Almacenamiento

```
.pipeline/
├── logs/
│   ├── abc-123.jsonl              # Todo lo que paso en el pipeline abc-123
│   ├── def-456.jsonl              # Todo lo que paso en el pipeline def-456
│   └── system.jsonl               # Logs de sistema (Director, Integrador, DLQ, infrastructure)
```

**Nota de implementacion:** Los archivos de log se almacenan en un directorio plano (sin subdirectorios por fecha). Cada `request_id` tiene su propio archivo JSONL.

**Dos tipos de archivos:**

| Archivo | Contenido | Cuando se crea |
|---|---|---|
| `{request_id}.jsonl` | Todo lo que paso en un pipeline especifico | Cuando el Core recibe un request |
| `system.jsonl` | Logs del Director, Integrador, Circuit Breakers, DLQ, infraestructura | Siempre (mientras el Service corre) |

Cada request_id tiene su propio archivo. Esto permite ver la historia completa de un pipeline en un solo lugar, sin filtrar.

### Ejemplo: log completo de un pipeline

```jsonl
{"timestamp":"2026-02-14T12:00:00.000Z","level":"info","source":"inbound.rest","request_id":"abc-123","action":"request.received","message":"POST /pipeline/run","data":{"branch":"feature/auth","tier_override":null}}
{"timestamp":"2026-02-14T12:00:00.005Z","level":"info","source":"core.pipeline","request_id":"abc-123","action":"pipeline.start","message":"Pipeline iniciado","data":{"branch":"feature/auth"}}
{"timestamp":"2026-02-14T12:00:00.010Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git diff --stat main...feature/auth","data":{"files_changed":12,"lines_added":340,"lines_removed":50},"duration_ms":45}
{"timestamp":"2026-02-14T12:00:00.060Z","level":"info","source":"core.pipeline","request_id":"abc-123","action":"tier.classified","message":"Cambio clasificado como Large","data":{"tier":"large","reason":"12 files, 390 lines"}}
{"timestamp":"2026-02-14T12:00:00.070Z","level":"info","source":"core.containers","request_id":"abc-123","action":"containers.detect","message":"compose.yml detectado en worktree","data":{"compose_file":"compose.yml"}}
{"timestamp":"2026-02-14T12:00:02.000Z","level":"info","source":"core.containers","request_id":"abc-123","action":"containers.start","message":"Containers levantados via podman compose","data":{"exposed_ports":{"web":3000}},"duration_ms":1930}
{"timestamp":"2026-02-14T12:00:04.500Z","level":"info","source":"core.containers","request_id":"abc-123","action":"containers.healthy","message":"Health check passed","data":{"app_url":"http://localhost:3000"},"duration_ms":2500}
{"timestamp":"2026-02-14T12:00:05.000Z","level":"info","source":"core.containers","request_id":"abc-123","action":"browser.ready","message":"CDP browser listo (Playwright)","data":{"mcp_tools":["cdp_navigate","cdp_screenshot","cdp_get_dom"]},"duration_ms":500}
{"timestamp":"2026-02-14T12:00:05.010Z","level":"info","source":"event-bus","request_id":"abc-123","action":"event.publish","message":"pipeline.containers.ready publicado","data":{"subscribers":3}}
{"timestamp":"2026-02-14T12:00:05.080Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git checkout -b pipeline/feature/auth feature/auth","data":{"new_branch":"pipeline/feature/auth"},"duration_ms":120}
{"timestamp":"2026-02-14T12:00:05.200Z","level":"info","source":"core.pipeline","request_id":"abc-123","action":"agents.spawn","message":"Lanzando 8 agentes (tier: large) con browser tools","data":{"agents":["tests","security","architecture","dependencies","code_quality","performance","accessibility","documentation"],"browser_tools":true}}
{"timestamp":"2026-02-14T12:00:00.210Z","level":"info","source":"core.agent.tests","request_id":"abc-123","action":"agent.start","message":"Agente Tests iniciado"}
{"timestamp":"2026-02-14T12:00:00.210Z","level":"info","source":"core.agent.security","request_id":"abc-123","action":"agent.start","message":"Agente Security iniciado"}
{"timestamp":"2026-02-14T12:00:05.100Z","level":"debug","source":"core.agent.security","request_id":"abc-123","action":"scan.file","message":"Scanning src/auth.ts","data":{"file":"src/auth.ts","lines":145}}
{"timestamp":"2026-02-14T12:00:08.300Z","level":"warn","source":"core.agent.security","request_id":"abc-123","action":"vulnerability.found","message":"Token JWT sin expiracion","data":{"file":"src/auth.ts","line":42,"severity":"HIGH","type":"missing-token-expiration"}}
{"timestamp":"2026-02-14T12:00:15.000Z","level":"info","source":"core.agent.tests","request_id":"abc-123","action":"agent.complete","message":"Tests completados: 25/25 passed","data":{"total":25,"passed":25,"failed":0,"coverage":"87%"},"duration_ms":14790}
{"timestamp":"2026-02-14T12:00:22.000Z","level":"error","source":"core.agent.security","request_id":"abc-123","action":"agent.complete","message":"Security fallo: 1 vulnerabilidad HIGH","data":{"status":"fail","vulnerabilities":[{"type":"missing-token-expiration","severity":"HIGH","file":"src/auth.ts","line":42}]},"duration_ms":21790}
{"timestamp":"2026-02-14T12:00:22.050Z","level":"info","source":"core.correction","request_id":"abc-123","action":"correction.start","message":"Auto-correccion intento 1/3 para security","data":{"attempt":1,"agent":"security","issue":"missing-token-expiration"}}
{"timestamp":"2026-02-14T12:00:25.000Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git diff (correccion aplicada)","data":{"files_changed":1,"diff":"+  expiresIn: '1h'"}}
{"timestamp":"2026-02-14T12:00:25.100Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git commit -m 'fix(pipeline/security): add JWT token expiration'","data":{"sha":"fa3b2c1"},"duration_ms":80}
{"timestamp":"2026-02-14T12:00:25.200Z","level":"info","source":"core.correction","request_id":"abc-123","action":"correction.complete","message":"Correccion exitosa","data":{"attempt":1,"success":true}}
{"timestamp":"2026-02-14T12:00:30.000Z","level":"info","source":"core.agent.security","request_id":"abc-123","action":"agent.rerun","message":"Re-ejecutando security post-correccion","data":{"attempt":2}}
{"timestamp":"2026-02-14T12:00:35.000Z","level":"info","source":"core.agent.security","request_id":"abc-123","action":"agent.complete","message":"Security passed post-correccion","data":{"status":"pass"},"duration_ms":5000}
{"timestamp":"2026-02-14T12:00:35.050Z","level":"info","source":"core.pipeline","request_id":"abc-123","action":"pipeline.approved","message":"Pipeline aprobado","data":{"approved":true,"corrections":["security: token expiration"],"main_sha_at_start":"abc123def"}}
{"timestamp":"2026-02-14T12:00:35.060Z","level":"info","source":"event-bus","request_id":"abc-123","action":"event.publish","message":"pipeline.completed publicado","data":{"subscribers":4}}
{"timestamp":"2026-02-14T12:00:35.070Z","level":"info","source":"adapter.outbound.manifest","request_id":"abc-123","action":"manifest.write","message":"Rama agregada a ready[]","data":{"branch":"feature/auth"}}
{"timestamp":"2026-02-14T12:00:35.080Z","level":"info","source":"adapter.outbound.webhook","request_id":"abc-123","action":"webhook.send","message":"POST https://mi-app.com/api/pipeline/events","data":{"event_type":"pipeline.completed","status_code":200},"duration_ms":150}
{"timestamp":"2026-02-14T12:00:35.100Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git checkout feature/auth && git merge pipeline/feature/auth","data":{"merge_back":true},"duration_ms":200}
{"timestamp":"2026-02-14T12:00:35.300Z","level":"info","source":"saga","request_id":"abc-123","action":"saga.complete","message":"Saga completada: todos los pasos exitosos","data":{"steps_completed":["create_branch","run_agents","auto_correct","merge_back"]}}
```

### Ejemplo: log del Director (system.jsonl)

```jsonl
{"timestamp":"2026-02-14T12:00:35.100Z","level":"info","source":"director","request_id":null,"action":"director.activate","message":"Director activado por pipeline.completed","data":{"trigger":"event","manifest_ready":1}}
{"timestamp":"2026-02-14T12:00:35.110Z","level":"info","source":"director","request_id":null,"action":"manifest.read","message":"Manifest: 1 en ready, 0 en pending_merge","data":{"ready":["feature/auth"],"pending_merge":[]}}
{"timestamp":"2026-02-14T12:00:35.120Z","level":"info","source":"director","request_id":null,"action":"branch.eligible","message":"feature/auth elegible para integracion","data":{"branch":"feature/auth","priority":1,"depends_on":[],"deps_satisfied":true}}
{"timestamp":"2026-02-14T12:00:35.130Z","level":"info","source":"integrator","request_id":null,"action":"integration.start","message":"Preparando PR para feature/auth","data":{"branch":"feature/auth","target":"main"}}
{"timestamp":"2026-02-14T12:00:35.150Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git checkout -b integration/feature/auth main","duration_ms":100}
{"timestamp":"2026-02-14T12:00:35.260Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git merge --no-ff pipeline/feature/auth","data":{"conflicts":false},"duration_ms":150}
{"timestamp":"2026-02-14T12:00:40.000Z","level":"info","source":"github","request_id":null,"action":"gh.pr.create","message":"PR creado","data":{"pr_number":42,"pr_url":"https://github.com/org/repo/pull/42","title":"Integrate: feature/auth","base":"main","head":"integration/feature/auth"},"duration_ms":4600}
{"timestamp":"2026-02-14T12:00:40.010Z","level":"info","source":"adapter.outbound.manifest","request_id":null,"action":"manifest.move","message":"feature/auth movida de ready a pending_merge","data":{"branch":"feature/auth","pr_number":42}}
{"timestamp":"2026-02-14T12:05:00.000Z","level":"info","source":"github","request_id":null,"action":"gh.webhook.received","message":"PR #42 mergeado por humano","data":{"pr_number":42,"merged_by":"developer","commit_sha":"xyz789"}}
{"timestamp":"2026-02-14T12:05:00.050Z","level":"info","source":"adapter.outbound.manifest","request_id":null,"action":"manifest.move","message":"feature/auth movida de pending_merge a merge_history","data":{"branch":"feature/auth","commit_sha":"xyz789"}}
{"timestamp":"2026-02-14T12:05:00.100Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git branch -d pipeline/feature/auth","data":{"deleted":true},"duration_ms":50}
{"timestamp":"2026-02-14T12:05:00.160Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git push origin --delete pipeline/feature/auth","duration_ms":800}
{"timestamp":"2026-02-14T12:05:00.170Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git branch -d integration/feature/auth","data":{"deleted":true},"duration_ms":50}
{"timestamp":"2026-02-14T12:05:01.000Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git push origin --delete integration/feature/auth","duration_ms":780}
{"timestamp":"2026-02-14T12:05:01.050Z","level":"info","source":"director","request_id":null,"action":"cleanup.complete","message":"Ramas limpiadas para feature/auth","data":{"deleted":["pipeline/feature/auth","integration/feature/auth"]}}
```

### Consultas sobre logs

El formato JSONL + campos fijos permite consultar con herramientas estandar:

```bash
# Todo lo que paso en un pipeline especifico
cat .pipeline/logs/abc-123.jsonl

# Solo errores
cat .pipeline/logs/*.jsonl | jq 'select(.level == "error")'

# Todos los comandos git de un pipeline
cat .pipeline/logs/abc-123.jsonl | jq 'select(.source == "git")'

# Acciones del Director
cat .pipeline/logs/system.jsonl | jq 'select(.source == "director")'

# Lo que hizo un componente especifico
cat .pipeline/logs/abc-123.jsonl | jq 'select(.source == "pipeline.agent")'

# Webhooks que fallaron
cat .pipeline/logs/system.jsonl | jq 'select(.source == "webhook" and .level == "error")'
```

### Configuracion

```yaml
logging:
  level: "info"                      # Nivel minimo: debug | info | warn | error
  path: ".pipeline/logs/"
  format: "jsonl"
  retention_days: 30                 # Eliminar logs mas viejos de 30 dias
  per_request: true                  # Crear archivo por request_id
  system_log: true                   # Log de sistema (Director, infra)
  console:
    enabled: true                    # Mostrar logs en stdout del Service
    level: "info"                    # Nivel para console (puede ser diferente)
    color: true                      # Colorear por nivel
  sources:                           # Habilitar/deshabilitar sources especificos
    git: true                        # Loggear cada comando git
    github: true                     # Loggear cada llamada a GitHub API
    agents: true                     # Loggear acciones de agentes
    event_bus: true                  # Loggear publicacion de eventos
    adapters: true                   # Loggear outbound adapters
```

### REST API para logs

El Pipeline Service expone endpoints para consultar logs sin acceder al filesystem:

```
GET /logs/pipeline/{request_id}
GET /logs/pipeline/{request_id}?source=pipeline.agent
GET /logs/pipeline/{request_id}?level=error

GET /logs/system
GET /logs/system?source=director
GET /logs/system?level=warn

GET /logs/requests                     # Lista todos los request_ids con logs
```

Todos los endpoints soportan query params: `source`, `level`, `from` (timestamp), `to` (timestamp), `limit`, `offset`.

---

## 5. El REST API del Pipeline Service

El Pipeline Service expone un REST API. Es la unica forma en que los sistemas externos se comunican con el pipeline. No hay SDK, no hay spawn de procesos, no hay librerias. **Solo HTTP.**

### 5.1 Endpoints

#### POST /pipeline/run — Ejecutar pipeline sobre una rama

```
POST /pipeline/run
Content-Type: application/json
Authorization: Bearer {token}

{
  "branch": "feature/auth",
  "worktree_path": "/path/to/worktree",
  "priority": 1,
  "depends_on": [],
  "metadata": {
    "task_id": "TASK-123",
    "triggered_by": "my-app"
  }
}
```

**Respuesta inmediata (202 Accepted):**

```json
{
  "request_id": "abc-123-uuid",
  "status": "accepted",
  "pipeline_branch": "pipeline/feature/auth",
  "events_url": "/pipeline/abc-123-uuid/events"
}
```

El Service responde `202 Accepted` inmediatamente. **No bloquea.** El cliente no espera a que termine. Los resultados llegan via:
- Outbound webhooks (el Service llama al cliente)
- SSE stream (el cliente escucha)
- Polling al endpoint de status

#### GET /pipeline/:request_id — Estado de un pipeline

```
GET /pipeline/abc-123-uuid

{
  "request_id": "abc-123-uuid",
  "branch": "feature/auth",
  "status": "running",          // accepted | running | correcting | approved | failed | error
  "started_at": "2026-02-14T12:00:00Z",
  "agents": {
    "tests":         { "status": "pass",    "details": "25/25" },
    "security":      { "status": "running", "details": null },
    "architecture":  { "status": "pass",    "details": "OK" },
    "performance":   { "status": "pending", "details": null },
    "dependencies":  { "status": "pass",    "details": "Todas OK" },
    "code_quality":  { "status": "pending", "details": null },
    "accessibility": { "status": "skipped", "details": "Sin cambios UI" },
    "documentation": { "status": "pending", "details": null }
  },
  "corrections": [],
  "metadata": { "task_id": "TASK-123" }
}
```

#### GET /pipeline/:request_id/events — Stream de eventos (SSE)

```
GET /pipeline/abc-123-uuid/events
Accept: text/event-stream

data: {"event_type":"pipeline.started","timestamp":"2026-02-14T12:00:00Z","data":{"branch":"feature/auth"}}

data: {"event_type":"pipeline.agent.completed","timestamp":"2026-02-14T12:00:15Z","data":{"agent":"tests","status":"pass"}}

data: {"event_type":"pipeline.agent.completed","timestamp":"2026-02-14T12:00:22Z","data":{"agent":"security","status":"fail"}}

data: {"event_type":"pipeline.correction.started","timestamp":"2026-02-14T12:00:23Z","data":{"attempt":1,"agent":"security"}}

data: {"event_type":"pipeline.completed","timestamp":"2026-02-14T12:00:45Z","data":{"approved":true}}
```

Este endpoint permite a cualquier cliente recibir eventos en tiempo real via Server-Sent Events. El cliente abre la conexion y recibe eventos a medida que ocurren.

#### POST /director/run — Activar el Director manualmente

```
POST /director/run
Authorization: Bearer {token}

{}
```

Respuesta:

```json
{
  "cycle_id": "dir-789",
  "status": "started",
  "manifest_entries": 2
}
```

#### GET /director/status — Estado del Director

```
GET /director/status

{
  "last_cycle": "2026-02-14T12:10:00Z",
  "manifest": {
    "ready": 2,
    "pending_merge": 1,
    "merge_history": 1
  },
  "merge_queue": [
    { "branch": "feature/auth", "priority": 1, "eligible": true },
    { "branch": "feature/ui", "priority": 3, "eligible": false, "blocked_by": "feature/api" }
  ]
}
```

#### GET /logs/pipeline/:request_id — Logs de un pipeline

```
GET /logs/pipeline/abc-123?source=pipeline.agent&level=warn

[
  {
    "timestamp": "2026-02-14T12:00:08.300Z",
    "level": "warn",
    "source": "core.agent.security",
    "action": "vulnerability.found",
    "message": "Token JWT sin expiracion",
    "data": { "file": "src/auth.ts", "line": 42, "severity": "HIGH" }
  }
]
```

Query params: `source`, `level`, `action`, `from` (timestamp), `to` (timestamp), `limit`.

#### GET /logs/system — Logs de sistema

```
GET /logs/system?source=director

[
  {
    "timestamp": "2026-02-14T12:00:35.100Z",
    "level": "info",
    "source": "director",
    "action": "director.activate",
    "message": "Director activado por pipeline.completed"
  }
]
```

### 5.2 Outbound: Como el Service notifica a los clientes

El Pipeline Service **activamente notifica** a los sistemas externos cuando algo pasa. Los clientes no necesitan hacer polling.

#### Webhooks (Push)

El Service hace HTTP POST a URLs configuradas cuando ocurren eventos:

```
Pipeline Service ─── POST ──► https://mi-app.com/api/pipeline/events
                               {
                                 "event_type": "pipeline.completed",
                                 "request_id": "abc-123",
                                 "data": { "branch": "feature/auth", "approved": true, "results": {...} },
                                 "metadata": { "task_id": "TASK-123" }
                               }
```

Los webhooks se configuran en `.pipeline/config.yaml`:

```yaml
adapters:
  outbound:
    client_notifier:
      enabled: true
      url: "${CLIENT_WEBHOOK_URL}"    # URL del cliente que quiere recibir eventos
      auth: "bearer-token"
      token: "${CLIENT_API_TOKEN}"
      events:                          # Solo los eventos que le interesan al cliente
        - "pipeline.started"
        - "pipeline.agent.completed"
        - "pipeline.completed"
        - "pipeline.failed"
        - "integration.pr.created"
        - "integration.pr.merged"
        - "integration.completed"
```

#### SSE (Server-Sent Events)

Cualquier cliente puede abrir una conexion SSE al endpoint `/pipeline/:id/events` y recibir eventos en tiempo real. Util para UIs que quieren mostrar progreso.

#### Internos (dentro del Service)

Estos outbound adapters viven dentro del Service y no requieren configuracion externa:

| Adapter interno | Que hace |
|---|---|
| **Manifest Writer** | Escucha `pipeline.completed` y escribe en `.pipeline/manifest.json` |
| **Director Trigger** | Escucha `pipeline.completed` y activa el Director |
| **Event Persister** | Escribe cada evento en `.pipeline/events/*.jsonl` para auditoria |

### 5.3 Adapters internos detallados

#### Manifest Writer

```
Event Bus                           Manifest Writer                     manifest.json
    │                                     │                                  │
    │  pipeline.completed                 │                                  │
    │  { approved: true,                  │                                  │
    │    branch: "feature/auth",          │                                  │
    │    results: {...} }                 │                                  │
    │ ───────────────────────────────────►│                                  │
    │                                     │  Append to ready[]:              │
    │                                     │  {                               │
    │                                     │    branch: "feature/auth",       │
    │                                     │    pipeline_result: {...},       │
    │                                     │    ready_at: "2026-..."          │
    │                                     │  }                               │
    │                                     │ ────────────────────────────────►│
    │                                     │                                  │
```

**Regla clave:** Solo escribe si `approved: true`. Si el pipeline falla, el manifiesto no se toca.

#### GitHub Notifier

```
on pipeline.completed:
  if metadata.pr_number:
    gh pr comment {pr_number} --body "Pipeline passed ✅\n{formatted_results}"

on pipeline.failed:
  if metadata.pr_number:
    gh pr comment {pr_number} --body "Pipeline failed ❌\n{formatted_failures}"
```

#### Slack Notifier

```
on pipeline.completed:
  slack.post("#dev", "✅ {branch} aprobado — {summary}")

on pipeline.failed:
  slack.post("#dev", "❌ {branch} fallo — {failures}")
  slack.post("#dev", "@{author} necesita intervencion manual")
```

### 5.4 Agregar un outbound adapter nuevo

Para conectar un sistema nuevo al Pipeline Service, solo se necesita:

1. Crear un modulo dentro del Service que escuche eventos del Event Bus
2. Traducir los eventos a la accion del sistema externo
3. Agregar la configuracion en `.pipeline/config.yaml`

**Ejemplo: agregar un adapter para Discord**

```
// Dentro del Pipeline Service: adapters/discord-notifier.ts
eventBus.on("pipeline.completed", (event) => {
  discord.send(CHANNEL_ID, {
    embeds: [{
      title: `✅ Pipeline aprobado: ${event.data.branch}`,
      fields: Object.entries(event.data.results).map(([agent, result]) => ({
        name: agent,
        value: result.status,
        inline: true
      }))
    }]
  })
})
```

**Cero cambios al Core. Cero cambios a otros adapters. Cero cambios a los clientes.** Solo se agrega un modulo al Service.

---

## 6. Integracion con Clientes Externos

Cualquier servicio web es un **cliente puro** del Pipeline Service. No spawna procesos, no gestiona agentes, no sabe como funciona el pipeline. Solo hace HTTP requests y recibe HTTP callbacks.

### Lo que un cliente necesita hacer

Solo dos cosas:

#### 1. Enviar worktrees a procesar (HTTP POST)

Cuando el cliente decide que un worktree debe pasar por el pipeline:

```
POST https://pipeline-service:3100/pipeline/run
Content-Type: application/json
Authorization: Bearer {token}

{
  "branch": "feature/auth",
  "worktree_path": "/path/to/worktree-auth",
  "priority": 1,
  "depends_on": [],
  "metadata": {
    "task_id": "TASK-123",
    "callback_url": "https://mi-app.com/api/pipeline/events"
  }
}
```

El cliente ya conoce la rama y el path del worktree. Solo los envia.

Respuesta inmediata:
```json
{ "request_id": "abc-123", "status": "accepted" }
```

El cliente guarda el `request_id` asociado a su tarea y sigue con su vida.

#### 2. Recibir notificaciones (HTTP endpoint)

Exponer un endpoint donde el Pipeline Service envie updates:

```
POST /api/pipeline/events    ← El cliente expone esto
Content-Type: application/json

{
  "event_type": "pipeline.completed",
  "request_id": "abc-123",
  "data": {
    "branch": "feature/auth",
    "approved": true,
    "results": {
      "tests": { "status": "pass", "details": "25/25" },
      "security": { "status": "pass", "details": "Corregido automaticamente" },
      ...
    },
    "corrections_applied": ["security: token expiration"]
  },
  "metadata": {
    "task_id": "TASK-123"
  }
}
```

El cliente lee `metadata.task_id`, busca la entidad correspondiente, y actualiza su estado. Eso es todo.

### Mapa de eventos → acciones sugeridas para el cliente

| Evento que recibe | Accion sugerida |
|---|---|
| `pipeline.started` | Marcar tarea como "Pipeline Running" |
| `pipeline.agent.completed` | Actualizar progreso (ej: "5/8 agentes completados") |
| `pipeline.correction.started` | Mostrar indicador "Auto-corrigiendo..." |
| `pipeline.completed` { approved: true } | Marcar tarea como "Approved" |
| `pipeline.failed` | Marcar tarea como "Needs Attention" con detalles |
| `integration.pr.created` | Marcar tarea como "PR Created" con link al PR |
| `integration.pr.merged` | Marcar tarea como "Merged" |
| `integration.completed` | Marcar tarea como "Done" |
| `integration.failed` | Marcar tarea como "Integration Failed" con detalles |

El cliente decide como mapear estos eventos a su propia logica. Puede ser columnas de un tablero, estados en una base de datos, notificaciones a usuarios, etc.

### Opcion alternativa: SSE en vez de webhooks

Si el cliente prefiere **escuchar** en vez de **recibir**, puede abrir una conexion SSE:

```javascript
// En el cliente (frontend o backend)
const eventSource = new EventSource(
  `https://pipeline-service:3100/pipeline/${requestId}/events`
)

eventSource.onmessage = (event) => {
  const pipelineEvent = JSON.parse(event.data)

  switch (pipelineEvent.event_type) {
    case 'pipeline.started':
      updateTask(taskId, { status: 'pipeline_running' })
      break
    case 'pipeline.agent.completed':
      updateTaskProgress(taskId, pipelineEvent.data)
      break
    case 'pipeline.completed':
      updateTask(taskId, { status: 'approved', results: pipelineEvent.data.results })
      eventSource.close()
      break
    case 'pipeline.failed':
      updateTask(taskId, { status: 'needs_attention', failures: pipelineEvent.data.failures })
      eventSource.close()
      break
  }
}
```

### Diagrama completo: Cliente ↔ Pipeline Service

```
Cliente (cualquier servicio web)                       Pipeline Service
     │                                                       │
     │  1. Decide procesar un worktree                       │
     │                                                       │
     │  POST /pipeline/run                                   │
     │  { branch, worktree_path, metadata: { task_id } }    │
     │ ─────────────────────────────────────────────────────►│
     │                                                       │
     │  202 Accepted { request_id }                          │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (cliente guarda request_id)                          │  (internamente: crea rama pipeline/,
     │  (cliente sigue con su vida)                          │   corre 8 agentes, auto-corrige...)
     │                                                       │
     │               ... minutos pasan ...                   │
     │                                                       │
     │  POST /api/pipeline/events (webhook al cliente)       │
     │  { event_type: "pipeline.started", task_id }          │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (cliente actualiza estado: "Pipeline Running")       │
     │                                                       │
     │  POST /api/pipeline/events                            │
     │  { event_type: "pipeline.agent.completed",            │
     │    data: { agent: "tests", status: "pass" } }         │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (cliente actualiza progreso: "1/8 agentes")          │
     │                                                       │
     │  ... mas eventos de agentes ...                       │
     │                                                       │
     │  POST /api/pipeline/events                            │
     │  { event_type: "pipeline.completed",                  │
     │    data: { approved: true, results: {...} } }         │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (cliente marca como "Approved")                      │
     │                                                       │
     │  ... Director detecta, despacha al Integrador ...     │
     │                                                       │
     │  POST /api/pipeline/events                            │
     │  { event_type: "integration.pr.created",              │
     │    data: { branch: "feature/auth",                    │
     │            pr_number: 42, pr_url: "..." } }           │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (cliente marca como "PR Created" con link)           │
     │                                                       │
     │  ... humano revisa y aprueba PR #42 en GitHub ...     │
     │                                                       │
     │  POST /api/pipeline/events                            │
     │  { event_type: "integration.pr.merged",               │
     │    data: { branch: "feature/auth",                    │
     │            pr_number: 42, commit_sha: "abc123" } }    │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (cliente marca como "Done" ✅)                        │
     │                                                       │
```

### Resumen: Lo que un cliente necesita implementar

```
1. triggerPipeline(task)              → HTTP POST al Pipeline Service (5 lineas)
2. handlePipelineEvent(event)         → Recibir webhook y actualizar estado (switch con 6 cases)
3. mapEventToStatus(eventType)        → Traducir event_type a estado interno (tabla de mapeo)
```

Tres funciones. El cliente no sabe que existen agentes, que hay un Event Bus, que hay un Director, que hay auto-correccion. Solo sabe: "mando un POST con un worktree, recibo webhooks con resultados."

---

## 6. La Rama de Pipeline

Cuando el Core recibe un `PipelineRequest`, lo primero que hace es crear una rama dedicada para el proceso de revision. Esto protege la rama original del desarrollador.

### Por que una rama separada

1. **Proteccion** — La rama del desarrollador queda intacta como referencia
2. **Aislamiento** — Las auto-correcciones no contaminan el trabajo original
3. **Rollback** — Si algo sale mal, se descarta la rama `pipeline/` y la original sigue igual
4. **Trazabilidad** — Se puede hacer diff entre la original y la de pipeline para ver exactamente que corrigio el sistema

### Flujo de la rama

```
feature/auth                      pipeline/feature/auth
    │                                     │
    │  (desarrollador termina)            │
    │                                     │
    ├──── checkout ──────────────────────►│  Copia exacta
    │                                     │
    │                                     │  [8 agentes corren]
    │                                     │
    │                                     │  ❌ security falla
    │                                     │
    │                                     │  [auto-correccion]
    │                                     │  commit: "fix: token expiration"
    │                                     │
    │                                     │  [re-verificacion]
    │                                     │  ✅ todo pasa
    │                                     │
    │                                     │  pipeline.completed { approved: true }
    │                                     │
    │  ◄──── merge back ─────────────────│  Los fixes vuelven a la rama original
    │                                     │
    │  (rama lista para integracion)      │  (se puede eliminar)
    │                                     │
```

### Nomenclatura

| Rama original | Rama de pipeline |
|---|---|
| `feature/auth` | `pipeline/feature/auth` |
| `fix/login-bug` | `pipeline/fix/login-bug` |
| `refactor/api` | `pipeline/refactor/api` 

### Que pasa si main cambia mientras el pipeline esta corriendo

El Core registra el SHA de main al crear la rama `pipeline/{branch}`. Si main avanza durante la ejecucion del pipeline:

```
pipeline/feature/auth se creo cuando main estaba en abc123
         │
         │  ... pipeline corriendo (minutos) ...
         │
         │  Mientras tanto: PR #41 se mergea a main → main ahora esta en def456
         │
         ▼
Pipeline termina: approved: true
         │
         ▼
¿main_sha_at_start == main HEAD actual?
         │
    ┌────┴────┐
    │         │
  Si (=)    No (≠)
    │         │
    │    El pipeline valido contra
    │    un main que ya no existe.
    │         │
    │    ¿Los archivos modificados en main
    │     se solapan con los de esta rama?
    │         │
    │    ┌────┴────┐
    │    │         │
    │  Sin      Con
    │  solape   solape
    │    │         │
    │    │    Re-ejecutar pipeline
    │    │    sobre main actual
    │    │         │
    ▼    ▼         ▼
  Aprobado      Emitir pipeline.rebase_needed
  (flujo normal)
```

El Core guarda `main_sha_at_start` en el evento `pipeline.completed`. El Integrador usa esto para saber si necesita hacer rebase al crear la rama `integration/`.

**Regla:** El pipeline **no se invalida** automaticamente cuando main cambia. La validacion contra main actual ocurre en el paso de integracion (cuando el Integrador crea la rama `integration/` y re-ejecuta el pipeline post-merge). Esto evita re-ejecuciones innecesarias.

### Configuracion

```yaml
pipeline:
  branch:
    prefix: "pipeline/"           # Prefijo para ramas de pipeline
    merge_back: true              # Mergear correcciones de vuelta a la rama original
    delete_after_merge: true      # Eliminar rama pipeline/ despues de merge exitoso
    keep_on_failure: true         # Mantener rama pipeline/ si falla (para debugging)
```

---

## 7. El Pipeline: 8 Agentes de Calidad

El pipeline tiene 8 agentes, pero **no siempre corren los 8**. El Core analiza el tamano y tipo de la modificacion para decidir cuantos agentes ejecutar.

### 7.0 Tiers de ejecucion

El Core hace `git diff --stat` contra `base_branch` para clasificar el cambio. Antes de lanzar los agentes, el sistema ejecuta un **Paso 0: Infraestructura de Containers** con dos capas: (1) **siempre** crea un sandbox container Podman donde corre el agente (obligatorio), y (2) opcionalmente, si el proyecto tiene un `compose.yml`, levanta containers de proyecto, espera health checks, y crea un servidor MCP con herramientas de browser (Playwright CDP). Si hay containers de proyecto disponibles, **todos los agentes** reciben acceso a herramientas de browser (`cdp_navigate`, `cdp_screenshot`, `cdp_get_dom`).

```
PipelineRequest recibido
         │
         ▼
Clasificar tier: git diff --stat base_branch...HEAD
         │
         ▼
   ┌─────┴──────────────────────────────┐
   │  Clasificar:                        │
   │                                     │
   │  archivos_modificados = N           │
   │  lineas_cambiadas = M              │
   └─────┬──────────────────────────────┘
         │
         ▼
   ┌─────────────────────────────────────┐
   │  Paso 0: Container Infrastructure   │
   │                                     │
   │  OBLIGATORIO:                       │
   │  1. Verificar Podman instalado      │
   │  2. podman build (imagen sandbox)   │
   │  3. podman run -d (sandbox)         │
   │     → mount worktree read-only      │
   │     → copiar archivos a /workspace  │
   │     → git init + fetch + checkout   │
   │  4. createSpawnFn(requestId)        │
   │     → agente corre via podman exec  │
   │                                     │
   │  OPCIONAL (si compose.yml existe):  │
   │  5. podman compose up -d            │
   │  6. waitForHealthy() → HTTP poll    │
   │  7. createCdpMcpServer(appUrl)      │
   │     → Playwright headless Chrome    │
   │     → MCP tools: cdp_navigate,      │
   │       cdp_screenshot, cdp_get_dom   │
   │                                     │
   │  Si NO hay compose:                 │
   │  → Sandbox listo, sin browser tools │
   │    (mcpServers = undefined)         │
   └─────┬──────────────────────────────┘
         │
    ┌────┴────────────┬──────────────────┐
    │                 │                  │
    ▼                 ▼                  ▼
 SMALL              MEDIUM             LARGE
 2 agentes          5 agentes          8 agentes
    │                 │                  │
    ▼                 ▼                  ▼
┌──────┐┌──────┐  ┌──────┐┌──────┐  ┌──────┐┌──────┐┌──────┐
│Tests ││Secur.│  │Archi.││Deps. │  │Perf. ││Acces.││Docs. │
└──────┘└──────┘  │Code Q│       │  └──────┘└──────┘└──────┘
                  └──────┘└──────┘
                  (+ los 2 de Small)  (+ los 5 de Medium)

Todos los agentes corren dentro del sandbox container (via podman exec).
Si hay containers de proyecto, reciben mcpServers con cdp_* tools.
```

#### Criterios de clasificacion

| Tier | Criterio | Agentes | Ejemplo |
|---|---|---|---|
| **Small** | ≤ 3 archivos modificados, ≤ 50 lineas, 0 archivos nuevos, sin cambios en deps | Tests, Security (2) | Bug fix, typo, config change |
| **Medium** | 4-10 archivos o 51-300 lineas, o archivos nuevos, o deps modificadas | + Architecture, Dependencies, Code Quality (5) | Nueva feature, refactor parcial |
| **Large** | > 10 archivos o > 300 lineas, o cambios en UI, o modulos nuevos | + Performance, Accessibility, Documentation (8) | Modulo nuevo, cambio arquitectonico, feature con UI |

#### Escalado automatico

El tier puede **escalar** durante la ejecucion. Si un agente de tier Small detecta un problema grave, el Core puede decidir escalar a Medium o Large:

```
Small (Tests + Security)
  │
  ├── Tests: ✅ pasa  →  se queda en Small
  │
  └── Security: ❌ encuentra vulnerabilidad critica
       → Escalar a Medium (agregar Architecture, Dependencies, Code Quality)
       → Re-evaluar si necesita Large
```

#### Configuracion de tiers

```yaml
pipeline:
  tiers:
    small:
      max_files: 3
      max_lines: 50
      max_new_files: 0
      agents: [tests, security]
    medium:
      max_files: 10
      max_lines: 300
      agents: [tests, security, architecture, dependencies, code_quality]
    large:
      agents: [tests, security, architecture, dependencies, code_quality, performance, accessibility, documentation]
  tier_override: null               # Forzar un tier especifico (ignora clasificacion)
```

Un cliente tambien puede forzar el tier en el request:

```json
{
  "branch": "feature/auth",
  "worktree_path": "/path/to/worktree",
  "config": {
    "tier_override": "large"
  }
}
```

#### Diagrama de ejecucion (con tier y containers)

```
PipelineRequest recibido
         │
         ▼
Clasificar cambio → tier = medium
         │
         ▼
┌─────────────────────────────────────┐
│  Paso 0: Container Infrastructure   │
│                                     │
│  SIEMPRE:                           │
│    Sandbox container (Podman)       │
│    → copy worktree → git clone      │
│    → spawnFn = podman exec          │
│                                     │
│  ¿compose.yml en worktree?          │
│    Si → podman compose up           │
│         → health check              │
│         → Playwright CDP browser    │
│         → mcpServers = { cdp-browser }
│    No → mcpServers = undefined      │
│         (sandbox listo, sin browser)│
└─────────────┬───────────────────────┘
              │
              ▼
   UN AGENTE (dentro del sandbox via podman exec)
   lanza 5 subagentes (tier medium)
   con mcpServers inyectados (si hay containers de proyecto)
         │
    ┌────┼────┬────┬────┬────┐
    │    │    │    │    │    │
    ▼    ▼    ▼    ▼    ▼    ▼    (todos en paralelo)
┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐
│Tests ││Secur.││Archi.││Deps. ││Code Q│
│ 🌐  ││      ││      ││      ││      │  🌐 = usa browser tools
└──┬───┘└──┬───┘└──┬───┘└──┬───┘└──┬───┘
   │       │       │       │       │
   └───────┴───────┴───────┴───────┘
                     │
                     ▼
           Agente consolida resultados
                     │
              ┌──────┴──────┐
              │             │
           ✅ PASA       ❌ FALLA
              │             │
              ▼             ▼
        Emite evento   Auto-correccion
        pipeline.      sobre rama
        completed      pipeline/{branch}
              │             │
              └──────┬──────┘
                     ▼
           Cleanup: containers + browser
           (containerManager.cleanup)
```

### 7.1 Agente de Pruebas [BLOQUEANTE] — Tier: Small

Verifica que el codigo funcione correctamente.

- Ejecuta la suite de tests existente
- Verifica que no se introdujeron regresiones
- Evalua cobertura de codigo sobre las lineas modificadas
- Sugiere tests faltantes para codigo nuevo

**Criterio de bloqueo:** Cualquier test fallando.

### 7.2 Agente de Seguridad [BLOQUEANTE] — Tier: Small

Analiza vulnerabilidades de seguridad.

- Inyeccion SQL, XSS, command injection (OWASP Top 10)
- Manejo de secretos y credenciales expuestas
- Validacion de inputs en boundaries del sistema
- Dependencias con CVEs conocidos

**Criterio de bloqueo:** Vulnerabilidad de severidad CRITICAL o HIGH.

### 7.3 Agente de Arquitectura [BLOQUEANTE] — Tier: Medium

Evalua el diseno y estructura del codigo.

- Principios SOLID y patrones del proyecto
- Acoplamiento entre modulos
- Cohesion de componentes
- Deuda tecnica introducida
- Atributos de calidad (mantenibilidad, extensibilidad)

**Criterio de bloqueo:** Violacion de principios arquitectonicos del proyecto.

### 7.4 Agente de Performance [WARNING] — Tier: Large

Detecta problemas de rendimiento.

- Algoritmos ineficientes (O(n^2) innecesarios)
- Memory leaks potenciales
- Queries N+1 a base de datos
- Operaciones bloqueantes en paths criticos

**Criterio de bloqueo:** No bloquea. Reporta warnings.

### 7.5 Agente de Dependencias [BLOQUEANTE] — Tier: Medium

Audita las dependencias del proyecto.

- Licencias incompatibles con el proyecto
- Vulnerabilidades conocidas (CVEs)
- Dependencias abandonadas o sin mantenimiento
- Dependencias innecesarias

**Criterio de bloqueo:** CVE critico o licencia incompatible.

### 7.6 Agente de Code Quality [WARNING] — Tier: Medium

Va mas alla del linting — entiende el contexto del proyecto.

- Consistencia con naming conventions del proyecto
- Codigo duplicado introducido
- Complejidad ciclomatica excesiva
- Patrones que difieren del resto del codebase

**Criterio de bloqueo:** No bloquea. Reporta warnings.

### 7.7 Agente de Accesibilidad [CONDICIONAL] — Tier: Large

Se activa solo cuando hay cambios en UI.

- Contraste de colores (WCAG AA/AAA)
- Navegacion por teclado
- Compatibilidad con screen readers
- ARIA labels y roles semanticos

**Criterio de bloqueo:** Bloquea solo si hay violaciones WCAG nivel A.

### 7.8 Agente de Documentacion [WARNING] — Tier: Large

Verifica que la documentacion acompane al codigo.

- README actualizado si cambio la API publica
- Changelog para breaking changes
- Docstrings en funciones publicas nuevas
- Diagramas actualizados si cambio la arquitectura

**Criterio de bloqueo:** No bloquea. Reporta sugerencias.

### 7.9 Infraestructura de Containers y Browser Tools

El pipeline integra un **Paso 0 de infraestructura** que tiene dos capas: un **sandbox container obligatorio** donde corre el agente, y **containers de proyecto opcionales** con browser tools. Esto ocurre **antes** de que los agentes arranquen.

#### Dos capas de containers

| Capa | Obligatoria | Que hace |
|------|-------------|----------|
| **Sandbox** (SandboxManager) | **Si** — Podman es requisito. Sin Podman el pipeline falla. | Crea un container aislado donde corre el agente Claude. Los archivos del worktree se copian al container y se inicializa un repo git fresco. |
| **Proyecto** (ContainerService + CDP) | No — solo si existe `compose.yml` | Levanta los servicios del proyecto (app, DB, etc.), espera health checks, y crea un browser headless (Playwright CDP) con herramientas MCP. |

#### Arquitectura de Containers

```
@a-parallel/core/containers (libreria)        @a-parallel/agent (orquestacion)
┌──────────────────────────────┐              ┌────────────────────────────────┐
│ SandboxManager               │              │ ContainerManager               │
│  - isPodmanAvailable()       │◄─────────────│  - setup(worktreePath, reqId)  │
│  - ensureImage()             │              │  - cleanup(worktreePath, reqId)│
│  - startSandbox()            │              │  - cleanupAll()                │
│  - createSpawnFn()           │              │  - killOrphans()               │
│  - stopSandbox()             │              │                                │
│  - killOrphans()             │              │ Mantiene mapa de instancias:   │
│                              │              │ cdpInstances: Map<path, CDP>   │
│ ContainerService             │              │                                │
│  - detectComposeFile()       │◄─────────────│ Se inyecta en PipelineRunner   │
│  - startContainers()         │              └────────────────────────────────┘
│  - waitForHealthy()          │
│  - stopContainers()          │
│                              │
│ createCdpMcpServer()         │
│  - Playwright headless Chrome│
│  - MCP tools (cdp_*)         │
└──────────────────────────────┘
```

- **`@a-parallel/core/containers`** — Libreria reutilizable. Contiene `SandboxManager`, `ContainerService`, y `createCdpMcpServer`.
- **`ContainerManager`** — Orquestacion especifica del pipeline. Vive en `packages/agent/src/infrastructure/`.

#### Flujo del Paso 0

```
PipelineRunner.run(request)
         │
         ▼
  containerManager.setup(worktree_path, request_id)
         │
         ├── 1. Verificar Podman disponible (OBLIGATORIO)
         │      → Si no esta instalado → throw Error con instrucciones de instalacion
         │
         ├── 2. Crear sandbox container (SIEMPRE)
         │      → podman build (imagen a-parallel-sandbox, lazy, una sola vez)
         │      → podman run -d (monta worktree read-only en /mnt/source)
         │      → Copiar archivos (excluyendo .git) a /workspace
         │      → Inicializar repo git fresco:
         │         a. git init + git remote add origin
         │         b. git fetch origin {branch} --depth=50
         │         c. git checkout -b {branch} FETCH_HEAD
         │         (fallback: git init + git add -A + git commit)
         │      → createSpawnFn(requestId) → custom spawn function
         │         (el agente Claude corre dentro del container via podman exec)
         │
         ├── 3. Detectar compose file (OPCIONAL)
         │      → Busca compose.yml, compose.yaml, docker-compose.yml
         │      → Si NO existe → return (sandbox listo, sin browser)
         │
         ├── 4. Levantar servicios del proyecto (si compose existe)
         │      → podman compose up -d
         │      → waitForHealthy() → HTTP poll
         │
         ├── 5. Encontrar app URL del primer puerto expuesto
         │      → http://localhost:{firstPort}
         │
         └── 6. createCdpMcpServer({ appUrl })
                → Lanza Playwright headless Chrome
                → Navega a appUrl
                → Crea MCP server con 3 tools:
                   • cdp_navigate(url) — Navegar a una URL
                   • cdp_screenshot() — Captura de pantalla (PNG)
                   • cdp_get_dom(selector?) — Obtener HTML/DOM
                → Retorna { server } para inyectar en mcpServers
```

#### Estrategia de Copy + Clone

El sandbox **no usa bind-mounts** para el worktree. En su lugar:

1. El worktree del host se monta **read-only** en `/mnt/source`
2. Los archivos (excluyendo `.git`) se **copian** a `/workspace` dentro del container
3. Se inicializa un **repo git fresco**: `git init` → `git remote add origin` → `git fetch --depth=50` → `git checkout`

**Por que no bind-mount?**
- Evita problemas de permisos entre host y container
- Evita problemas de paths cross-platform (Windows ↔ Linux)
- Los worktrees de git tienen un archivo `.git` pointer (no un directorio), y bind-mountear esto no funciona correctamente dentro del container
- El container tiene su propio `.git` directory con historia real

**Fallback:** Si no hay remote URL o el fetch falla, se usa un `git init` local con todos los archivos commiteados como snapshot.

#### Inyeccion en Agentes

El `spawnClaudeCodeProcess` y opcionalmente `mcpServers` se pasan al `orchestrator.startAgent()`. El agente Claude SDK corre **dentro del sandbox** via `podman exec`, y recibe las tools de browser via MCP si hay containers de proyecto:

```
orchestrator.startAgent({
  prompt: buildPipelinePrompt(..., hasBrowserTools: true),
  cwd: '/workspace',                                   // ← dentro del container
  spawnClaudeCodeProcess: sandboxSpawnFn,               // ← podman exec wrapper
  mcpServers: { 'cdp-browser': cdp.server },            // ← solo si compose existe
  ...
})
```

Cuando `hasBrowserTools` es `true`, el prompt incluye una seccion adicional:

```
## Browser Tools Available
The application is running in a container. You have access to browser automation tools via MCP:
- `cdp_navigate` — Navigate the browser to a URL
- `cdp_screenshot` — Take a screenshot of the current page (returns PNG image)
- `cdp_get_dom` — Get the HTML/DOM of the page or a specific CSS selector

Use these tools for E2E testing, accessibility checks, visual verification, and performance inspection.
```

#### Agentes que usan Browser Tools

| Agente | Uso de browser | Ejemplo |
|--------|---------------|---------|
| **Tests** | E2E testing, visual regression | `cdp_navigate` → `cdp_screenshot` → comparar |
| **Security** | Verificar CSP headers, XSS | `cdp_navigate` → inspeccionar respuesta |
| **Accessibility** | WCAG compliance, ARIA | `cdp_get_dom` → analizar estructura semantica |
| **Performance** | Load time, rendering | `cdp_navigate` → medir tiempo de carga |
| **Style** | Visual consistency | `cdp_screenshot` → verificar layout |
| Otros | Segun necesidad | Cualquier agente puede usar las tools |

#### Cleanup

Los containers y el browser se limpian en tres puntos:

1. **Pipeline completa/falla/se detiene** — Event listener en `index.ts` escucha `pipeline.completed`, `pipeline.failed`, `pipeline.stopped` y llama `containerManager.cleanup(worktreePath, requestId)` con un delay de 3 segundos (para dejar que el proceso SDK termine limpiamente)
2. **Shutdown del servicio** — En `SIGINT`/`SIGTERM`, se llama `containerManager.cleanupAll()` que dispose todas las instancias CDP, detiene containers de proyecto, y detiene todos los sandboxes
3. **Startup del servicio** — `containerManager.killOrphans()` busca y elimina containers `pipeline-sandbox-*` huerfanos de ejecuciones anteriores (crashes, terminales cerradas)

```
pipeline.completed / pipeline.failed / pipeline.stopped
         │
         ▼ (3s delay para que el SDK termine)
containerManager.cleanup(worktreePath, requestId)
         │
         ├── cdp.dispose()          → Cierra Playwright browser
         ├── stopContainers()       → podman compose down (proyecto)
         └── stopSandbox(requestId) → podman rm -f (sandbox)
```

#### Degradacion: Sandbox obligatorio, Proyecto opcional

El **sandbox es obligatorio**. Si Podman no esta instalado, `setup()` lanza un error con instrucciones de instalacion y el pipeline **no puede correr**.

Los **containers de proyecto son opcionales**. Si falla cualquier paso del setup de proyecto (compose file no existe, health check timeout, Playwright falla), el pipeline **continua sin browser tools**. Los agentes pueden seguir ejecutando sus verificaciones estaticas normalmente dentro del sandbox.

```typescript
// En ContainerManager.setup():
// 1. Sandbox — OBLIGATORIO (throw si falla)
const podmanAvailable = await this.sandboxManager.isPodmanAvailable();
if (!podmanAvailable) {
  throw new Error('Podman is required to run pipelines...');
}
await this.sandboxManager.startSandbox({ requestId, worktreePath });

// 2. Proyecto — OPCIONAL (catch + warn si falla)
try {
  const composeFile = await this.containerService.detectComposeFile(worktreePath);
  if (composeFile) {
    // ... start containers, wait for health, create CDP browser
  }
} catch (err) {
  logger.warn('Project container setup failed — continuing without browser tools');
}
```

### Skills que implementan cada agente

| Agente | Tier | Skill | Estado |
|---|---|---|---|
| Pruebas | Small | `anthropics/skills@webapp-testing` | Disponible |
| Seguridad | Small | `security-audit` | Instalada |
| Arquitectura | Medium | `architecture-eval` | Instalada |
| Dependencias | Medium | `jezweb/claude-skills@dependency-audit` | Disponible |
| Code Quality | Medium | `tursodatabase/turso@code-quality` | Disponible |
| Performance | Large | `addyosmani/web-quality-skills@performance` | Disponible |
| Accesibilidad | Large | `web-design-guidelines` | Instalada |
| Documentacion | Large | Custom (por crear) | Pendiente |

---

## 8. El Agente Director (Coordinador)

El Director no toca codigo. No "descubre" worktrees. **Reacciona a eventos y lee el manifiesto para saber que esta listo.**

### Como se activa el Director

El Director no necesita estar corriendo permanentemente. Se activa por eventos:

```
                                    ┌──────────────────────┐
                                    │   AGENTE DIRECTOR     │
                                    │                       │
  pipeline.completed ──────────────►│ 1. Lee manifest.json  │
  (via Event Bus)                   │ 2. Filtra elegibles   │
                                    │ 3. Resuelve deps      │
          o                         │ 4. Ordena prioridad   │
                                    │ 5. Despacha Integrador│
  Trigger manual ─────────────────►│                       │
  (CLI: pipeline director run)      └───────────┬───────────┘
                                                │
          o                                     ▼
                                    Despacha al Integrador
  Cron/scheduler ─────────────────►  para cada rama elegible
  (cada N minutos)
```

**Tres formas de activar al Director:**

| Metodo | Como funciona | Cuando usarlo |
|---|---|---|
| **Event-driven** | Un outbound adapter escucha `pipeline.completed` y lanza el Director | Flujo automatizado. El Director corre solo cuando hay algo nuevo. |
| **Manual** | `pipeline director run` desde la terminal | Debugging, control manual. |
| **Scheduled** | Un cron job que corre `pipeline director run` cada N minutos | Como fallback, por si un evento se perdio. |

### El Manifiesto (.pipeline/manifest.json)

El manifiesto es la **fuente de verdad** del estado de todas las ramas. No solo el Director lo lee — es lo que permite al sistema entero saber donde esta cada rama en cada momento.

El manifiesto tiene **tres listas** que representan el ciclo de vida de una rama:

```
ready[]          → Pipeline aprobo. Esperando que el Director despache al Integrador.
pending_merge[]  → PR creado en GitHub. Esperando aprobacion humana.
merge_history[]  → PR mergeado a main. Completado.
```

#### Maquina de estados de una rama

```
                    POST /pipeline/run
                           │
                           ▼
                    ┌──────────────┐
                    │  (pipeline   │       El manifiesto NO trackea este estado.
                    │   running)   │       El Core lo maneja via eventos.
                    │              │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │              │
                 ✅ aprobado    ❌ fallido → (fuera del manifiesto, requiere intervencion)
                    │
                    ▼
             ┌─────────────┐
             │   ready[]    │    Manifest Writer escribe aqui
             │              │    Director lee y despacha
             └──────┬───────┘
                    │
                    │ Director despacha → Integrador crea PR
                    ▼
          ┌──────────────────┐
          │  pending_merge[] │    PR abierto en GitHub
          │                  │    Esperando aprobacion humana
          │  (tiene pr_number│
          │   y pr_url)      │    Si main avanza → Integrador hace rebase del PR
          └──────┬───────────┘
                 │
                 │ Humano aprueba y mergea el PR (webhook de GitHub)
                 ▼
          ┌──────────────────┐
          │  merge_history[] │    Completado. Rama integrada en main.
          │                  │    Se limpian ramas pipeline/ e integration/
          └──────────────────┘
```

#### Estructura completa del manifiesto

```json
{
  "manifest": {
    "main_branch": "main",
    "main_head": "abc123def",
    "last_updated": "2026-02-14T12:10:00Z",

    "ready": [
      {
        "branch": "feature/auth",
        "pipeline_branch": "pipeline/feature/auth",
        "worktree_path": "../project-auth",
        "request_id": "abc-123",
        "pipeline_result": {
          "tests":         { "status": "pass", "details": "25/25" },
          "security":      { "status": "pass", "details": "Corregido: token expiration" },
          "architecture":  { "status": "pass", "details": "OK" },
          "performance":   { "status": "warning", "details": "O(n^2) en utils.ts:45" },
          "dependencies":  { "status": "pass", "details": "Todas OK" },
          "code_quality":  { "status": "pass", "details": "Consistente" },
          "accessibility": { "status": "skipped", "details": "Sin cambios UI" },
          "documentation": { "status": "warning", "details": "README desactualizado" }
        },
        "corrections_applied": [
          "security: agregado expiresIn a token JWT"
        ],
        "ready_at": "2026-02-14T12:00:00Z",
        "priority": 1,
        "depends_on": [],
        "metadata": {
          "triggered_by": "my-app",
          "task_id": "TASK-123"
        }
      }
    ],

    "pending_merge": [
      {
        "branch": "feature/api",
        "pipeline_branch": "pipeline/feature/api",
        "integration_branch": "integration/feature/api",
        "request_id": "def-456",
        "pr_number": 43,
        "pr_url": "https://github.com/org/repo/pull/43",
        "pr_created_at": "2026-02-14T12:06:00Z",
        "base_main_sha": "abc123def",
        "pipeline_result": { "...": "..." },
        "corrections_applied": [],
        "priority": 2,
        "depends_on": [],
        "metadata": {
          "triggered_by": "my-app",
          "task_id": "TASK-456"
        }
      }
    ],

    "merge_history": [
      {
        "branch": "feature/setup",
        "pr_number": 41,
        "commit_sha": "789xyz",
        "merged_at": "2026-02-14T11:50:00Z",
        "metadata": {
          "task_id": "TASK-100"
        }
      }
    ]
  }
}
```

**Campos clave en `pending_merge`:**

| Campo | Proposito |
|---|---|
| `integration_branch` | Rama que se uso para el PR. El Integrador la necesita para hacer rebase si main avanza. |
| `pr_number` / `pr_url` | Referencia al PR en GitHub. Para tracking y para actualizar el PR si es necesario. |
| `base_main_sha` | El SHA de main cuando se creo el PR. Permite detectar si main avanzo desde entonces. |

### Responsabilidades del Director

1. **Leer** el manifiesto para saber el estado de todas las ramas
2. **Validar** que los resultados del pipeline sean aceptables (todos los bloqueantes en "pass")
3. **Resolver dependencias** — si una rama depende de otra que aun no esta en `merge_history`, no la procesa
4. **Ordenar** por prioridad las que estan listas y sin dependencias pendientes
5. **Despachar** al Agente de Integracion para crear PRs
6. **Detectar PRs stale** — cuando main avanza, verificar si los PRs en `pending_merge` necesitan rebase
7. **Actualizar** el manifiesto moviendo entradas entre `ready`, `pending_merge`, y `merge_history`
8. **Limpiar ramas** — eliminar `pipeline/*` e `integration/*` despues de completar
9. **Emitir eventos** — en cada transicion de estado

### Logica del Director

El Director se activa por tres motivos diferentes, y la logica cambia segun el trigger:

```
ACTIVACION POR pipeline.completed (nuevo pipeline aprobado):

1. Leer .pipeline/manifest.json
2. Filtrar entradas de "ready":
   a. Verificar que todos los agentes bloqueantes esten en "pass"
   b. Verificar dependencias: ¿las ramas en depends_on ya estan en merge_history?
      - Si → elegible
      - No → saltar (esperar)
3. Ordenar elegibles por prioridad
4. Para cada elegible:
   → Emitir director.integration.dispatched { branch }
   → Despachar al Agente de Integracion
   → Al crear PR, mover de "ready" a "pending_merge"
   → Guardar base_main_sha = HEAD actual de main
   → Emitir director.integration.pr_created { branch, pr_number }
5. Si no hay elegibles → emitir director.cycle.completed { reason: "nothing_ready" }
```

```
ACTIVACION POR integration.pr.merged (un PR fue mergeado por humano):

1. Leer .pipeline/manifest.json
2. Mover la rama de "pending_merge" a "merge_history"
3. Registrar commit_sha y merged_at
4. Limpiar ramas:
   → git branch -d pipeline/{branch}
   → git branch -d integration/{branch}
   → git push origin --delete pipeline/{branch}
   → git push origin --delete integration/{branch}
5. Verificar PRs stale en "pending_merge":
   → Para cada entrada en pending_merge:
      → Si base_main_sha != HEAD actual de main:
         → El PR esta basado en un main viejo
         → Despachar al Integrador para rebase del PR
         → Emitir director.pr.rebase_needed { branch, pr_number }
6. Verificar si hay nuevas ramas en "ready" cuyas dependencias se cumplieron
   → Si feature/ui dependia de feature/api y feature/api acaba de mergearse
   → Ahora feature/ui es elegible → despachar al Integrador
7. Emitir director.cycle.completed { merged: [...], rebased: [...], dispatched: [...] }
```

```
ACTIVACION MANUAL o SCHEDULED (reconciliacion):

1. Leer .pipeline/manifest.json
2. Verificar consistencia:
   → ¿Hay PRs en "pending_merge" que ya fueron cerrados en GitHub? → Mover a "ready" (reintentar)
   → ¿Hay PRs en "pending_merge" con base_main_sha viejo? → Rebase
   → ¿Hay ramas en "ready" elegibles que no se procesaron? → Despachar
   → ¿Hay ramas pipeline/* o integration/* huerfanas? → Limpiar
3. Emitir director.cycle.completed con resumen
```

### Eventos del Director

| Evento | Cuando se emite | Data |
|---|---|---|
| `director.activated` | El Director comienza un ciclo | `{ trigger, manifest_entries: N }` |
| `director.integration.dispatched` | Se despacha una rama al Integrador | `{ branch, priority }` |
| `director.integration.pr_created` | El Integrador creo un PR para la rama | `{ branch, pr_number, pr_url }` |
| `director.pr.rebase_needed` | Un PR quedo desactualizado porque main avanzo | `{ branch, pr_number, old_base, new_base }` |
| `director.pr.rebased` | El Integrador actualizo un PR stale | `{ branch, pr_number }` |
| `director.branch.cleaned` | Se elimino una rama temporal (pipeline/ o integration/) | `{ branch, type }` |
| `director.cycle.completed` | El Director termino su ciclo | `{ merged: [...], rebased: [...], dispatched: [...], cleaned: [...] }` |

Estos eventos tambien fluyen por el Event Bus. Los outbound adapters pueden reaccionar — por ejemplo, el Client Notifier puede notificar al cliente que la tarea esta en "PR Created" cuando ve `integration.pr.created` y en "Done" cuando ve `integration.pr.merged`.

### Quien escribe en el manifiesto

```
Pipeline Core termina
       │
       ▼
Emite pipeline.completed (o pipeline.failed)
       │
       ▼
  ┌────┴────┐
  │         │
✅ approved ❌ not approved
  │         │
  ▼         ▼
Manifest    Nada se escribe
Writer      en el manifiesto.
escribe     El Director nunca
en el       se entera.
manifiesto  Requiere intervencion
  │         manual.
  ▼
Director lo ve
en su proxima activacion
```

**Regla clave:** Solo el Manifest Writer escribe en el manifiesto, y solo cuando `approved: true`. Si el pipeline falla, el manifiesto no se toca. El Director nunca ve ramas con problemas.

---

## 9. El Agente de Integracion (PR Creator)

Toma ramas aprobadas y **crea Pull Requests hacia main**. Es el unico que prepara codigo para la rama principal. El merge final requiere aprobacion humana.

### Responsabilidades

1. **Preparar rama de integracion** — `integration/{branch}` basada en main con los cambios mergeados
2. **Resolver conflictos** automaticamente (semantico, no solo textual)
3. **Deduplicar** codigo cuando dos ramas crearon funcionalidad similar
4. **Re-ejecutar pipeline** sobre el resultado del merge para verificar integridad
5. **Crear Pull Request** hacia main con resumen completo de resultados del pipeline
6. **Taggear el PR** con labels segun el resultado (auto-corrected, conflicts-resolved, clean)
7. **Actualizar PRs stale** — cuando main avanza, hacer rebase de la rama `integration/` y force-push para actualizar el PR
8. **Limpiar ramas** — eliminar `pipeline/{branch}` e `integration/{branch}` despues de que el PR se mergea

### Flujo de Integracion via Pull Request

```
Merge Queue: [feature/auth (P1), feature/ui (P3)]
                    │
                    ▼
        ┌─── feature/auth ───────────────────────┐
        │                                         │
        │  1. Crear rama integration/feature/auth │
        │     basada en main                      │
        │       │                                 │
        │  2. Merge pipeline/feature/auth         │
        │     en integration/feature/auth         │
        │       │                                 │
        │  ┌────┴────┐                            │
        │  │         │                            │
        │ Sin      Con                            │
        │ conflicto conflicto                     │
        │  │         │                            │
        │  │    Resolver                          │
        │  │    (semantico)                       │
        │  │         │                            │
        │  └────┬────┘                            │
        │       │                                 │
        │  3. Pipeline sobre resultado merge      │
        │       │                                 │
        │    ✅ Pasa                                │
        │       │                                 │
        │  4. Push integration/feature/auth       │
        │       │                                 │
        │  5. gh pr create                        │
        │     --base main                         │
        │     --head integration/feature/auth     │
        │     --title "Integrate: feature/auth"   │
        │     --body "{resumen de 8 agentes}"     │
        │       │                                 │
        │  6. Emitir integration.pr.created       │
        │     { pr_number, pr_url }               │
        │                                         │
        └───────┬─────────────────────────────────┘
                │
                ▼
        PR abierto, esperando aprobacion humana
                │
                ▼ (humano aprueba y mergea)
                │
        main actualizado
                │
                ▼
        ┌─── feature/ui ────────────────────────┐
        │                                        │
        │  1. Crear rama integration/feature/ui  │
        │     basada en main (ya tiene auth)     │
        │       │                                │
        │  2. Merge pipeline/feature/ui          │
        │       │                                │
        │  Detectar duplicacion                  │
        │       │                                │
        │  ┌────┴────┐                           │
        │  │         │                           │
        │ Sin      Con                           │
        │ duplicac. duplicac.                    │
        │  │         │                           │
        │  │    Deduplicar                       │
        │  │    (unificar)                       │
        │  │         │                           │
        │  └────┬────┘                           │
        │       │                                │
        │  3. Pipeline sobre resultado merge     │
        │       │                                │
        │    ✅ Pasa                               │
        │       │                                │
        │  4. Push + gh pr create                │
        │       │                                │
        │  5. Emitir integration.pr.created      │
        │                                        │
        └────────────────────────────────────────┘
```

**Nota:** El Integrador mergea la rama `pipeline/{branch}` (que tiene las correcciones del pipeline), no la rama original del desarrollador.

### Contenido del Pull Request

El Integrador genera un PR con informacion completa para facilitar la revision humana:

```markdown
## Integrate: feature/auth

### Resumen del Pipeline
| Agente | Resultado | Detalles |
|--------|-----------|----------|
| Tests | ✅ Pass | 25/25 tests |
| Security | ✅ Pass | Corregido automaticamente |
| Architecture | ✅ Pass | SOLID OK |
| Performance | ⚠️ Warning | O(n^2) en utils.ts:45 |
| Dependencies | ✅ Pass | Todas OK |
| Code Quality | ✅ Pass | Consistente |
| Accessibility | ⏭️ Skipped | Sin cambios UI |
| Documentation | ⚠️ Warning | README desactualizado |

### Correcciones Automaticas
- **Security**: Agregado `expiresIn: '1h'` a token JWT

### Conflictos Resueltos
- Ninguno

### Pipeline Post-Merge
✅ Pipeline paso sobre el resultado del merge con main

---
🤖 Generado por Pipeline Service | Request ID: abc-123
```

### Rama de integracion

El Integrador no mergea directamente a main. Crea una rama intermedia:

| Rama | Proposito |
|---|---|
| `feature/auth` | Rama original del desarrollador |
| `pipeline/feature/auth` | Rama donde corrio el pipeline + correcciones |
| `integration/feature/auth` | Rama preparada para PR (pipeline/ mergeada sobre main actual) |

Esto permite que el PR muestre un diff limpio contra main actual, incluyendo todas las correcciones del pipeline.

### Tipos de Problemas que Resuelve

**1. Conflictos de Archivos**

Dos worktrees modificaron el mismo archivo en las mismas lineas.

```
Worktree A: modifico auth.ts linea 45-50
Worktree C: modifico auth.ts linea 47-52
→ Resolucion: analisis semantico de ambos cambios, merge inteligente
```

**2. Duplicacion de Logica**

Dos worktrees crearon funcionalidad equivalente con nombres diferentes.

```
Worktree A: creo validateEmail() en utils.ts
Worktree C: creo isValidEmail() en helpers.ts
→ Resolucion: mantener una, redirigir imports, eliminar duplicada
```

**3. Dependencias Contradictorias**

Dos worktrees agregaron la misma dependencia en versiones diferentes.

```
Worktree A: agrego lodash@4.17
Worktree C: agrego lodash@4.18
→ Resolucion: usar la mas reciente compatible
```

**4. Migraciones Conflictivas**

Dos worktrees crearon migraciones con el mismo numero de secuencia.

```
Worktree A: migration_005_add_users
Worktree C: migration_005_add_products
→ Resolucion: renumerar una a migration_006
```

### Eventos del Integrador

| Evento | Cuando se emite | Data |
|---|---|---|
| `integration.started` | Comenzo a preparar una rama | `{ branch, integration_branch, target: "main" }` |
| `integration.conflict.detected` | Detecto un conflicto | `{ branch, files, type }` |
| `integration.conflict.resolved` | Resolvio un conflicto | `{ branch, files, resolution }` |
| `integration.duplication.detected` | Detecto codigo duplicado | `{ branch, functions, files }` |
| `integration.duplication.resolved` | Deduplicado | `{ branch, kept, removed }` |
| `integration.pipeline.running` | Re-ejecutando pipeline post-merge | `{ branch }` |
| `integration.pr.created` | PR creado hacia main | `{ branch, pr_number, pr_url, pr_title }` |
| `integration.pr.rebased` | PR actualizado porque main avanzo | `{ branch, pr_number, old_base, new_base }` |
| `integration.pr.merged` | PR mergeado por humano (webhook de GitHub) | `{ branch, pr_number, commit_sha }` |
| `integration.cleanup` | Ramas temporales eliminadas | `{ pipeline_branch, integration_branch }` |
| `integration.completed` | Integracion completa (PR mergeado + cleanup) | `{ branch, commit_sha, pr_number }` |
| `integration.failed` | Preparacion de PR fallida | `{ branch, reason }` |

### Actualizacion de PRs cuando main avanza

Cuando un PR se mergea a main, los demas PRs abiertos quedan basados en un main viejo. El Integrador los actualiza:

```
PR #42 (feature/auth) se mergea a main
         │
         │  main avanzo: abc123 → def456
         │
         ▼
Director detecta: PR #43 (feature/api) tiene base_main_sha = abc123
         │
         ▼
Integrador rebase:
  1. git checkout integration/feature/api
  2. git rebase main
     ┌────┴────┐
     │         │
   Sin      Con
   conflicto conflicto
     │         │
     │    Resolver (semantico)
     │         │
     └────┬────┘
          │
  3. Re-ejecutar pipeline sobre resultado
  4. git push --force-with-lease origin integration/feature/api
  5. Actualizar PR body si hubo cambios
  6. Actualizar base_main_sha en manifest
  7. Emitir integration.pr.rebased { pr_number: 43 }
```

**`--force-with-lease`** en vez de `--force`: protege contra pushes concurrentes. Si alguien pusheo a la rama entre el rebase y el push, el comando falla en vez de sobreescribir.

### Limpieza de ramas

El pipeline genera ramas temporales que deben eliminarse cuando ya no son necesarias:

```
Evento                          Accion de limpieza
─────────────────────────────   ──────────────────────────────────────
pipeline.completed              → Eliminar pipeline/{branch} (despues del merge back)
  (si merge_back: true)           Solo si approved: true

integration.pr.merged           → Eliminar integration/{branch} (local + remote)
  (webhook de GitHub)             → Eliminar pipeline/{branch} si aun existe

pipeline.failed                 → Mantener pipeline/{branch} si keep_on_failure: true
  (para debugging)                → Eliminar despues de N dias (stale_branch_days)
```

El Director ejecuta la limpieza como parte de su ciclo cuando recibe `integration.pr.merged`. No es responsabilidad del Integrador — el Director tiene la vision global.

---

## 10. Flujo de Auto-correccion

Cuando el pipeline detecta problemas bloqueantes, el Core los corrige automaticamente **sobre la rama `pipeline/{branch}`**.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Rama: pipeline/feature/auth                            │
│                                                         │
│         ┌───────────────────┐                           │
│         │                   │                           │
│         ▼                   │                           │
│   Correr 8 agentes          │                           │
│   en paralelo               │                           │
│         │                   │                           │
│    ┌────┴────┐              │                           │
│    │         │              │                           │
│ ✅ Pasa   ❌ Falla ──► Corregir en pipeline/{branch}   │
│    │              (commit correcciones)                  │
│    │              (max 3 intentos)                       │
│    │                        │                           │
│    ▼                        │                           │
│ Emitir pipeline.completed   │                           │
│ { approved: true }          │                           │
│    │                                                    │
│    ▼                                                    │
│ Merge back: pipeline/{branch} → {branch}                │
│ (las correcciones vuelven a la rama original)           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Reglas de auto-correccion

1. **Maximo 3 intentos** — Evita loops infinitos
2. **Solo re-ejecuta agentes que fallaron** — No repite trabajo innecesario
3. **Cada correccion genera un commit en `pipeline/{branch}`** — Trazabilidad completa
4. **Si no puede corregir** — Emite `pipeline.failed` con diagnostico detallado
5. **Los commits de correccion** — Tienen formato estandar: `fix(pipeline): {descripcion del fix}`

### Eventos durante auto-correccion

Cada paso de la auto-correccion emite eventos, lo que permite a los outbound adapters mostrar progreso en tiempo real:

```
pipeline.round.completed     { round: 1, blocking_failures: ["security"] }
pipeline.correction.started  { attempt: 1, agent: "security", issue: "Token sin expiracion" }
pipeline.correction.completed { attempt: 1, agent: "security", success: true }
pipeline.agent.completed     { agent: "security", status: "pass" }
pipeline.round.completed     { round: 2, blocking_failures: [] }
pipeline.completed           { approved: true }
```

Un outbound adapter (como el Client Notifier) puede usar estos eventos para enviar progreso al cliente:

```
Card TASK-123:
  Status: Pipeline Running
  Progress:
    Round 1: 7/8 passed, 1 failed (security)
    Auto-correcting: security (attempt 1/3)
    Round 2: 8/8 passed ✅
  Result: Approved
```

---

## 11. Momento de Ejecucion del Pipeline

### Cuando se dispara

El pipeline se dispara cuando un sistema externo envia un `PipelineRequest` a traves de un inbound adapter. Los momentos tipicos son:

| Trigger | Descripcion | Inbound Adapter |
|---|---|---|
| **Request de un servicio web** | Un servicio externo envia un worktree a procesar | REST API |
| **PR abierto/actualizado** | Se abre o actualiza un Pull Request | Webhook Adapter |
| **Comando manual** | `pipeline run --branch feature/auth` | CLI Adapter |
| **Agente termina tarea** | Un agente de Claude Code termina su trabajo y llama al pipeline | MCP Adapter |
| **Scheduled** | Un cron job que corre el pipeline sobre ramas activas | CLI Adapter (via cron) |

### Flujo completo desde el trigger

```
                           AQUI
                            │
  Sistema externo ─► Adapter ─► Core ─► [Crear pipeline/{branch}] ─► [8 agentes] ─► Eventos
                                                                                       │
                                                                              ┌────────┴────────┐
                                                                              │                 │
                                                                        ✅ Approved        ❌ Failed
                                                                              │                 │
                                                                     Manifest Writer      Solo eventos
                                                                     escribe en manifest  (outbound adapters
                                                                              │            notifican)
                                                                              ▼
                                                                     Director lo procesa
                                                                     en su proxima activacion
```

### Se ejecuta en todas las tareas, pero no siempre los 8 agentes

El pipeline siempre corre — ninguna rama se salta el proceso. Pero la cantidad de agentes depende del tier del cambio:

| Tier | Agentes | Cuando |
|---|---|---|
| **Small** (2) | Tests, Security | Bug fix, config change, cambios menores |
| **Medium** (5) | + Architecture, Dependencies, Code Quality | Feature nueva, refactor |
| **Large** (8) | + Performance, Accessibility, Documentation | Modulo nuevo, cambios UI, cambio arquitectonico |

La clasificacion es automatica (basada en `git diff --stat`), pero el cliente puede forzarla con `tier_override` en el request. Tests y Security siempre corren — son el minimo innegociable.

---

## 12. Configuracion por Proyecto

```yaml
pipeline:
  # Rama de pipeline
  branch:
    prefix: "pipeline/"           # Prefijo para ramas de pipeline
    merge_back: true              # Mergear correcciones de vuelta a la rama original
    delete_after_merge: true      # Eliminar rama pipeline/ despues de merge exitoso
    keep_on_failure: true         # Mantener rama pipeline/ si falla (para debugging)

  # Tiers de ejecucion
  tiers:
    small:
      max_files: 3                    # Archivos modificados
      max_lines: 50                   # Lineas cambiadas
      max_new_files: 0                # Archivos nuevos
      agents: [tests, security]
    medium:
      max_files: 10
      max_lines: 300
      agents: [tests, security, architecture, dependencies, code_quality]
    large:                            # Todo lo que exceda medium
      agents: [tests, security, architecture, dependencies, code_quality, performance, accessibility, documentation]
  tier_override: null                 # Forzar tier: "small" | "medium" | "large" | null (auto)

  # Los 8 agentes de calidad
  agents:
    tests:
      enabled: true
      blocking: true
      tier: small                     # Siempre corre

    security:
      enabled: true
      blocking: true
      tier: small                     # Siempre corre

    architecture:
      enabled: true
      blocking: true
      tier: medium

    performance:
      enabled: true
      blocking: false
      tier: large

    dependencies:
      enabled: true
      blocking: true
      tier: medium

    code_quality:
      enabled: true
      blocking: false
      tier: medium

    accessibility:
      enabled: true
      blocking: conditional           # Solo bloquea WCAG nivel A
      tier: large
      condition: "changes_include_ui"

    documentation:
      enabled: true
      blocking: false
      priority: low

  # Auto-correccion
  auto_correction:
    enabled: true
    max_attempts: 3
    allowed_fixes:
      - security_vulnerabilities
      - failing_tests
      - code_style
    manual_only:
      - architectural_changes
      - dependency_upgrades

  # Integracion
  integration:
    mode: "pull-request"           # pull-request | auto-merge (PR recomendado)
    pr:
      draft: false                 # Crear como draft PR
      labels:                      # Labels automaticos segun resultado
        - "pipeline-approved"
        - "auto-corrected"         # Solo si hubo correcciones automaticas
        - "conflicts-resolved"     # Solo si hubo conflictos resueltos
      reviewers: []                # Reviewers automaticos (GitHub usernames)
      auto_merge: false            # Activar auto-merge de GitHub si CI pasa
    branch_prefix: "integration/"  # Prefijo para ramas de integracion
    merge_strategy: "merge-no-ff"  # merge-no-ff | rebase | squash (para el PR)
    deduplication: true
    post_merge_pipeline: true      # Re-ejecutar pipeline despues de merge
    rebase_active_worktrees: true  # Rebaser worktrees activos cuando main cambia

  # Event Bus
  event_bus:
    implementation: "local"        # local | redis | nats
    persistence:
      enabled: true
      path: ".pipeline/events/"
      format: "jsonl"
      retention_days: 30

  # Adapters
  adapters:
    inbound:
      rest_api:
        enabled: true
        port: 3100
        auth: "bearer-token"
      cli:
        enabled: true
      webhook:
        enabled: false
        path: "/webhooks"
        secret: "${WEBHOOK_SECRET}"
      mcp:
        enabled: true

    outbound:
      manifest_writer:
        enabled: true              # Siempre habilitado — es como el Director se entera
        path: ".pipeline/manifest.json"
      client_notifier:
        enabled: true
        api_url: "${CLIENT_WEBHOOK_URL}"
        auth: "bearer-token"
        events:
          - "pipeline.started"
          - "pipeline.agent.completed"
          - "pipeline.completed"
          - "pipeline.failed"
          - "integration.pr.created"
          - "integration.pr.merged"
          - "integration.completed"
      slack_notifier:
        enabled: false
        webhook_url: "${SLACK_WEBHOOK_URL}"
        channel: "#dev"
        events:
          - "pipeline.completed"
          - "pipeline.failed"
      github_notifier:
        enabled: false
        events:
          - "pipeline.completed"
          - "pipeline.failed"
      webhook_notifier:
        enabled: false
        url: "${CALLBACK_URL}"
        events: ["*"]             # Todos los eventos

  # Director
  director:
    activation: "event-driven"     # event-driven | scheduled | manual
    schedule: "*/5 * * * *"        # Solo si activation es "scheduled"
    events:
      - "pipeline.completed"       # Se activa cuando un pipeline termina

  # Resiliencia
  resilience:
    circuit_breaker:
      claude_code:
        failure_threshold: 3
        reset_timeout_seconds: 60
      github_api:
        failure_threshold: 5
        reset_timeout_seconds: 120
      webhooks:
        failure_threshold: 3
        reset_timeout_seconds: 30
    dead_letter:
      enabled: true
      path: ".pipeline/dlq/"
      max_retries: 5
      backoff: "exponential"
      base_delay_seconds: 5

  # Sagas
  saga:
    persistence_path: ".pipeline/sagas/"
    cleanup_after_days: 7            # Limpiar logs de sagas completadas

  # Logging
  logging:
    level: "info"                    # debug | info | warn | error
    path: ".pipeline/logs/"
    retention_days: 30
    per_request: true                # Archivo por request_id
    system_log: true                 # Log de sistema (Director, infra)
    console:
      enabled: true
      level: "info"
      color: true
    sources:
      git: true                      # Cada comando git
      github: true                   # Cada llamada a GitHub API
      agents: true                   # Acciones de agentes
      event_bus: true                # Publicacion de eventos
      adapters: true                 # Outbound adapters

  # Reporting
  reporting:
    format: summary                # summary | detailed | minimal
    show_warnings: true
    show_suggestions: true
```

---

## 13. Implementacion del Pipeline Service

### El Pipeline Service como aplicacion

El Pipeline Service es una **aplicacion Bun** que corre como paquete `@a-parallel/agent` dentro del monorepo:
1. Levanta un servidor HTTP (Hono) en el puerto 3002 para recibir requests
2. Usa `AgentOrchestrator` + `SDKClaudeProcess` del Claude Agent SDK para ejecutar agentes
3. Mantiene un Event Bus (eventemitter3) en memoria + persistencia JSONL en disco
4. Corre outbound adapters (webhooks genericos) como modulos internos
5. Auto-registra un ingest webhook para reenviar eventos a la UI principal

```
Pipeline Service (Bun + Hono — packages/agent)
│
├── src/
│   ├── index.ts                       # Composition root — wiring de todos los componentes
│   ├── server.ts                      # Bun HTTP server bootstrap + graceful shutdown
│   │
│   ├── routes/
│   │   ├── pipeline.ts                # POST /run, GET /list, GET /:id, GET /:id/events (SSE), POST /:id/stop
│   │   ├── director.ts               # POST /run, GET /status, GET /manifest
│   │   ├── webhooks.ts               # POST /github (inbound GitHub webhook)
│   │   └── logs.ts                    # GET /pipeline/:id, GET /system, GET /requests
│   │
│   ├── core/
│   │   ├── pipeline-runner.ts         # Orquesta agentes via AgentOrchestrator (Claude Agent SDK)
│   │   ├── event-mapper.ts            # CLIMessage → PipelineEvent (stateful, con correccion detection)
│   │   ├── state-machine.ts           # FSM generico + transiciones de pipeline y branch
│   │   ├── tier-classifier.ts         # git diff --stat → Small/Medium/Large
│   │   ├── prompt-builder.ts          # Construye system prompt para el agente pipeline
│   │   ├── director.ts               # Coordinador de integraciones (no LLM)
│   │   ├── integrator.ts             # Saga de integracion: fetch → branch → merge → push → PR
│   │   ├── manifest-manager.ts       # Lee/escribe .pipeline/manifest.json (ready/pending/history)
│   │   ├── manifest-types.ts          # Tipos del manifiesto
│   │   ├── branch-cleaner.ts          # Limpieza de ramas pipeline/ e integration/
│   │   └── saga.ts                    # Patron Saga con compensacion y persistencia
│   │
│   ├── infrastructure/
│   │   ├── event-bus.ts               # eventemitter3 + persistencia JSONL por request_id
│   │   ├── container-manager.ts       # Orquesta SandboxManager + ContainerService + CDP
│   │   ├── circuit-breaker.ts         # cockatiel: claude (3/60s) y github (5/120s)
│   │   ├── idempotency.ts            # Guarda de idempotencia por branch (memoria + disco)
│   │   ├── dlq.ts                     # Dead Letter Queue con backoff exponencial
│   │   ├── adapter.ts                 # AdapterManager: despacha eventos a outbound adapters
│   │   ├── webhook-adapter.ts         # Webhook generico con HMAC y filtro de eventos
│   │   ├── request-logger.ts          # Logs JSONL por request_id + system.jsonl
│   │   └── logger.ts                  # Pino logger (pretty en dev, JSON en prod)
│   │
│   ├── validation/
│   │   └── schemas.ts                 # Zod schemas para PipelineRun y DirectorRun
│   │
│   └── config/
│       ├── schema.ts                  # Zod schema completo con defaults
│       ├── loader.ts                  # Lee .pipeline/config.yaml + resuelve ${ENV_VARS}
│       └── defaults.ts               # Constante DEFAULT_CONFIG
│
├── package.json
└── tsconfig.json
```

### Mapeo de componentes a primitivas

| Componente | Implementacion | Descripcion |
|---|---|---|
| **HTTP Server** | Hono (Bun runtime, puerto 3002) | Recibe requests HTTP del mundo exterior |
| **Pipeline Core** | `AgentOrchestrator` + `SDKClaudeProcess` (Claude Agent SDK) | El Service usa el SDK directamente, no spawn de CLI |
| **8 Agentes** | Subagentes via Task tool (dentro del proceso Claude Code) | El Core lanza subagentes en paralelo, cada uno ejecuta una skill |
| **Sandbox** | `SandboxManager` → Podman container obligatorio | Cada pipeline corre dentro de un container aislado |
| **Director** | Clase TypeScript (no LLM) activada por eventos | Lee manifest, resuelve dependencias, ordena por prioridad, despacha al Integrador |
| **Integrador** | `AgentOrchestrator` (Claude Opus) para conflictos + git commands | Saga de 6 pasos: fetch → branch → merge → push → PR → checkout |
| **Event Bus** | eventemitter3 + archivos JSONL | Distribucion en memoria, persistencia en disco |
| **Outbound Adapters** | `WebhookAdapter` (generico) + ingest webhook (auto-registrado) | HTTP POST con HMAC opcional y filtro de eventos |
| **Config** | `.pipeline/config.yaml` (Zod validated) | Configuracion del proyecto con resolución de `${ENV_VARS}` |
| **Skills** | 8 skills instaladas en Claude Code | Cada una es un agente especializado del pipeline |

### Estructura de archivos del proyecto

```
proyecto/                              # Repo del usuario
├── .pipeline/
│   ├── manifest.json                  # Estado de ramas (ready, pending_merge, merge_history)
│   ├── config.yaml                    # Configuracion del pipeline para este proyecto
│   ├── active-pipelines.json          # Guarda de idempotencia (branch → request_id)
│   ├── events/                        # Historial de eventos (Event Bus persiste aqui)
│   │   ├── {request_id}.jsonl         # Eventos de un pipeline especifico
│   │   └── ...
│   ├── logs/                          # Logs estructurados JSONL
│   │   ├── {request_id}.jsonl         # Todo lo que paso en un pipeline especifico
│   │   └── system.jsonl               # Director, Integrador, DLQ, infraestructura
│   ├── sagas/                         # Log de transacciones en progreso (Saga pattern)
│   │   └── {request_id}.json          # Pasos completados por request_id
│   └── dlq/                           # Dead Letter Queue (eventos fallidos por adapter)
│       └── {adapter_name}/
│           └── {request_id}.jsonl     # Eventos que no se pudieron entregar
│
├── CLAUDE.md                          # Reglas del Director + Integrador
│
├── ../proyecto-worktree-auth/         # Worktree A (gestionado externamente)
│   └── CLAUDE.md                      # Reglas del worker
│
├── ../proyecto-worktree-api/          # Worktree B (gestionado externamente)
│   └── CLAUDE.md
│
└── ../proyecto-worktree-ui/           # Worktree C (gestionado externamente)
    └── CLAUDE.md
```

**Nota:** El Pipeline Service es una aplicacion separada. Puede correr en la misma maquina que los worktrees o en un servidor. Solo necesita acceso al filesystem de los worktrees y tener Claude Code instalado.

### Ejecucion del pipeline (lo que hace el Service internamente)

Cuando el HTTP server recibe un `POST /pipeline/run`, el Service:

```
# 1. Crear rama de pipeline
git checkout -b pipeline/feature/auth feature/auth

# 2. Los 8 agentes corren en paralelo como subagentes (Task tool)
Task(security-audit)         ──┐
Task(architecture-eval)      ──┤
Task(webapp-testing)         ──┤
Task(performance)            ──┼── PARALELO
Task(dependency-audit)       ──┤
Task(code-quality)           ──┤
Task(web-design-guidelines)  ──┤
Task(documentation-check)   ──┘

# 3. Consolidar resultados
# 4. Si algun bloqueante falla:
#    → Auto-correccion sobre pipeline/feature/auth
#    → Commit: "fix(pipeline): descripcion"
#    → Re-ejecutar solo agentes que fallaron
#    → Repetir (max 3 intentos)
# 5. Si todos los bloqueantes pasan:
#    → Emitir pipeline.completed { approved: true }
#    → Manifest Writer escribe en manifest.json
#    → Merge pipeline/feature/auth → feature/auth (si merge_back: true)
#    → Director detecta y despacha al Integrador
#    → Integrador crea rama integration/feature/auth basada en main
#    → Integrador mergea pipeline/feature/auth en integration/
#    → Integrador crea Pull Request hacia main con resumen del pipeline
#    → Humano revisa y aprueba el PR
# 6. Si falla despues de 3 intentos:
#    → Emitir pipeline.failed { approved: false }
#    → Outbound adapters notifican
```

---

## 14. Flujo Completo: Ejemplo Real

```
=== CLIENTE ENVIA WORKTREE A PROCESAR ===

Cliente: Tarea TASK-123 (feature/auth) lista para revision

  → Cliente hace POST al Pipeline Service:
    POST http://pipeline-service:3100/pipeline/run
    { branch: "feature/auth", worktree_path: "../project-auth", priority: 1,
      metadata: { task_id: "TASK-123" } }

  → Service acepta, genera PipelineRequest:
    { request_id: "abc-123", branch: "feature/auth", worktree_path: "../project-auth",
      metadata: { task_id: "TASK-123" } }

  → Core recibe PipelineRequest

=== PIPELINE CORE TRABAJA ===

Core: "Creando rama pipeline/feature/auth desde feature/auth"
  → Emite: pipeline.started { branch: "feature/auth", pipeline_branch: "pipeline/feature/auth" }
  → Client Notifier → POST al cliente { event: "pipeline.started", task_id: "TASK-123" }

Core: "Ejecutando 8 agentes en paralelo..."
  → Emite: pipeline.agents.started { agents: [...] }

  Task(security-audit)     → ❌ Token sin expiracion
  Task(architecture-eval)  → ✅ OK
  Task(webapp-testing)     → ✅ 25/25
  Task(performance)        → ✅ OK
  Task(dependency-audit)   → ✅ jsonwebtoken MIT, sin CVEs
  Task(code-quality)       → ✅ Consistente
  Task(accessibility)      → -- Skipped (sin UI)
  Task(documentation)      → ⚠️ README desactualizado

  → Emite: pipeline.round.completed { round: 1, blocking_failures: ["security"] }
  → Client Notifier → POST al cliente { progress: "7/8 passed, correcting..." }

Core: "1 bloqueante. Auto-corrigiendo en pipeline/feature/auth..."
  → Emite: pipeline.correction.started { attempt: 1, agent: "security" }

  [Agrega expiresIn: '1h' al token]
  [Commit en pipeline/feature/auth: "fix(pipeline): add JWT token expiration"]

  → Emite: pipeline.correction.completed { attempt: 1, success: true }

Core: "Re-ejecutando security-audit..."
  Task(security-audit)     → ✅ Corregido

  → Emite: pipeline.round.completed { round: 2, blocking_failures: [] }

Core: "Pipeline APROBADO."
  → Emite: pipeline.completed { approved: true, corrections: ["security: token expiration"] }

  → Manifest Writer escucha → Escribe en .pipeline/manifest.json
  → Client Notifier → POST al cliente { status: "approved", results: {...} }
  → Slack Notifier → POST #dev "✅ feature/auth aprobado (1 correccion automatica)"

Core: "Merge back: pipeline/feature/auth → feature/auth"
  → Las correcciones vuelven a la rama original

=== CLIENTE ENVIA OTRO WORKTREE ===

Cliente: Tarea TASK-456 (feature/api) lista para revision
  → POST al Pipeline Service... mismo flujo... pipeline pasa sin correcciones
  → Manifest Writer escribe en manifest.json

=== DIRECTOR SE ACTIVA ===

(Event Bus emitio pipeline.completed → Director Trigger lo detecta → spawn Director)

Director: "Activado. Leo manifest.json."
Director: "2 ramas listas: feature/auth (P1), feature/api (P2)"
Director: "feature/ui-dashboard no esta en el manifiesto — no la toco"
Director: "feature/ui-dashboard depende de feature/api — aun no mergeada"
  → Emite: director.activated { manifest_entries: 2 }

Director: "Merge queue: [auth (P1), api (P2)]"

Director: "Despachando feature/auth al Integrador"
  → Emite: director.integration.dispatched { branch: "feature/auth" }

=== AGENTE DE INTEGRACION ===

Integrador: "Preparando PR para pipeline/feature/auth → main"
  → Emite: integration.started { branch: "feature/auth", integration_branch: "integration/feature/auth" }
  → git checkout -b integration/feature/auth main
  → git merge --no-ff pipeline/feature/auth
  → Sin conflictos
  → Pipeline post-merge: ✅ pasa
  → git push origin integration/feature/auth
  → gh pr create --base main --head integration/feature/auth
    --title "Integrate: feature/auth"
    --body "## Pipeline Results\n| Tests ✅ | Security ✅ (auto-corrected) | ... |\n\n### Corrections\n- Security: token expiration"
  → Emite: integration.pr.created { branch: "feature/auth", pr_number: 42, pr_url: "https://github.com/..." }
  → Client Notifier → POST al cliente { task_id: "TASK-123", status: "pr_created", pr_url: "..." }

Integrador: "Preparando PR para pipeline/feature/api → main"
  → Emite: integration.started { branch: "feature/api", integration_branch: "integration/feature/api" }
  → git checkout -b integration/feature/api main
  → git merge --no-ff pipeline/feature/api
  → Conflicto en routes/index.ts (ambos agregaron rutas)
  → Emite: integration.conflict.detected { files: ["routes/index.ts"] }
  → Resolucion: combinar las rutas de ambos
  → Emite: integration.conflict.resolved { resolution: "combined routes" }
  → Pipeline post-merge: ✅ pasa
  → git push origin integration/feature/api
  → gh pr create --base main --head integration/feature/api
  → Emite: integration.pr.created { branch: "feature/api", pr_number: 43 }

Director: "2 PRs creados. Esperando aprobacion humana."
  → Emite: director.cycle.completed { prs_created: ["feature/auth (#42)", "feature/api (#43)"] }

=== HUMANO REVISA Y APRUEBA PR #42 ===

(GitHub webhook llega al Pipeline Service: PR #42 mergeado)
  → Emite: integration.pr.merged { branch: "feature/auth", pr_number: 42, commit_sha: "abc123" }
  → Director mueve feature/auth de "pending_merge" a "merge_history"
  → Client Notifier → POST al cliente { task_id: "TASK-123", status: "done" }

=== CLIENTE ENVIA TERCER WORKTREE ===

Cliente: Tarea TASK-789 (feature/ui-dashboard) lista para revision
  → POST al Pipeline Service...
  → Task(code-quality) detecta isValidEmail() — ya existe validateEmail() en main
  → Auto-correccion: redirige a validateEmail(), elimina isValidEmail()
  → Pipeline pasa
  → Manifest Writer escribe en manifest.json

=== DIRECTOR SE ACTIVA DE NUEVO ===

Director: "Leo manifest.json. feature/ui-dashboard lista."
Director: "Depende de feature/api → ya esta en merge_history ✅"
Director: "Merge queue: [ui-dashboard]"

Integrador: "Preparando PR para pipeline/feature/ui-dashboard → main"
  → git checkout -b integration/feature/ui-dashboard main
  → git merge --no-ff pipeline/feature/ui-dashboard
  → ✅ Sin conflictos, deduplicacion aplicada
  → Pipeline post-merge: ✅
  → git push origin integration/feature/ui-dashboard
  → gh pr create → PR #44
  → Emite: integration.pr.created { branch: "feature/ui-dashboard", pr_number: 44 }
  → Client Notifier → POST al cliente { task_id: "TASK-789", status: "pr_created", pr_url: "..." }

=== HUMANO REVISA Y APRUEBA PR #44 ===

(GitHub webhook: PR #44 mergeado)
  → Emite: integration.pr.merged { branch: "feature/ui-dashboard", pr_number: 44 }
  → Client Notifier → POST al cliente { task_id: "TASK-789", status: "done" }

=== FIN ===

Director: "Todas las tareas integradas en main."
  PR history:
    1. feature/auth  → PR #42 → main  (12:00)  [1 correccion: security]
    2. feature/api   → PR #43 → main  (12:03)  [1 conflicto resuelto]
    3. feature/ui    → PR #44 → main  (12:08)  [1 deduplicacion]

Cliente:
  TASK-123 (auth)  → Done ✅  (PR #42)
  TASK-456 (api)   → Done ✅  (PR #43)
  TASK-789 (ui)    → Done ✅  (PR #44)
```

---

## 15. Patrones de Diseno

El sistema usa 9 patrones. Cada uno resuelve un problema concreto en el flujo.

### Mapa de patrones

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            PIPELINE SERVICE                                  │
│                                                                              │
│  ┌─ INBOUND ──────────┐    ┌─ CORE ───────────────┐    ┌─ OUTBOUND ──────┐  │
│  │                     │    │                       │    │                  │  │
│  │  [Adapter]          │    │  [Command]            │    │  [Adapter]       │  │
│  │  REST → Request     │───►│  PipelineRequest      │    │  Event → HTTP    │  │
│  │  CLI  → Request     │    │                       │    │  Event → Slack   │  │
│  │  MCP  → Request     │    │  [Strategy]           │    │  Event → GitHub  │  │
│  │                     │    │  Tier → agentes       │    │                  │  │
│  │  [Idempotency]      │    │                       │    │  [Circuit Breaker│  │
│  │  Detectar duplicados│    │  [State Machine]      │    │   + Dead Letter] │  │
│  │  antes de aceptar   │    │  ready → pending      │    │  Si falla → DLQ  │  │
│  │                     │    │  → merge_history      │    │  Si caido → open │  │
│  └─────────────────────┘    │                       │    └──────────────────┘  │
│                              │  [Saga]               │                         │
│                              │  Compensacion en      │                         │
│                              │  cada paso             │                         │
│                              └───────────┬───────────┘                         │
│                                          │                                     │
│                                   [Observer/Pub-Sub]                           │
│                                    Event Bus                                  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 15.1 Adapter (Hexagonal)

**Donde:** Inbound adapters (REST, CLI, MCP) y Outbound adapters (Webhook, Slack, GitHub, Manifest Writer).

**Que resuelve:** El Core no sabe quien lo llamo ni a donde van los resultados. Los adapters traducen entre el mundo exterior y el contrato interno (`PipelineRequest` / `PipelineEvent`).

```
Mundo exterior          Adapter              Core
─────────────          ─────────            ─────
HTTP POST      →   REST Adapter    →   PipelineRequest
CLI args       →   CLI Adapter     →   PipelineRequest
MCP tool call  →   MCP Adapter     →   PipelineRequest

PipelineEvent  →   Webhook Adapter →   HTTP POST al cliente
PipelineEvent  →   Slack Adapter   →   Slack API
PipelineEvent  →   GitHub Adapter  →   gh pr comment
```

**Agregar un sistema nuevo** = crear un adapter. Cero cambios al Core, cero cambios a otros adapters.

### 15.2 Observer / Pub-Sub

**Donde:** Event Bus — conecta el Core con todos los outbound adapters.

**Que resuelve:** El Core emite eventos sin saber quien los escucha. Los adapters se suscriben a los eventos que les interesan. Desacoplamiento total.

```
Core emite:  pipeline.completed
                │
     Event Bus distribuye:
                │
     ┌──────────┼──────────┬──────────────┐
     │          │          │              │
  Manifest   Webhook    Slack          GitHub
  Writer     Notifier   Notifier      Notifier
```

**Regla:** El Core nunca llama a un adapter directamente. Todo pasa por el Event Bus.

### 15.3 Command

**Donde:** `PipelineRequest` es un comando — encapsula toda la informacion necesaria para ejecutar el pipeline.

**Que resuelve:** El request se puede serializar, persistir, re-ejecutar, y encolar. El Core no necesita saber de donde vino — solo procesa el comando.

```json
{
  "request_id": "abc-123",
  "branch": "feature/auth",
  "worktree_path": "/path/to/worktree",
  "config": { "tier_override": "large" },
  "metadata": { "task_id": "TASK-123" }
}
```

Esto permite:
- **Retry:** Si el pipeline falla por error transitorio, re-enviar el mismo comando
- **Auditoria:** Cada comando queda registrado
- **Cola:** El Director puede encolar comandos para el Integrador

### 15.4 Strategy

**Donde:** Sistema de tiers — el Core selecciona que agentes ejecutar segun el tamano del cambio.

**Que resuelve:** No todos los cambios necesitan los 8 agentes. La estrategia se selecciona automaticamente (Small/Medium/Large) o se fuerza via `tier_override`.

```
git diff --stat → clasificar → seleccionar estrategia
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                 Small           Medium           Large
                 [T, S]          [T,S,A,D,CQ]     [T,S,A,D,CQ,P,Ac,Do]
```

Cada tier define que agentes corren. Si un agente detecta un problema grave, el tier puede escalar.

### 15.5 State Machine

**Donde:** El manifiesto — ciclo de vida de cada rama a traves de `ready[]`, `pending_merge[]`, `merge_history[]`.

**Que resuelve:** En todo momento se sabe exactamente en que estado esta cada rama. Las transiciones son explicitas y validadas.

```
(pipeline running)  →  ready  →  pending_merge  →  merge_history
        ↓                              ↓
     failed                      pr_stale → rebased → pending_merge
```

**Transiciones validas:**
| De | A | Trigger |
|---|---|---|
| (running) | ready | `pipeline.completed` { approved: true } |
| (running) | (fuera) | `pipeline.failed` |
| ready | pending_merge | Director despacha, Integrador crea PR |
| pending_merge | pending_merge | PR stale → rebase → actualizar |
| pending_merge | ready | PR cerrado sin merge → reintentar |
| pending_merge | merge_history | `integration.pr.merged` |

Transiciones invalidas (el sistema las rechaza):
- ready → merge_history (no se puede saltar pending_merge)
- merge_history → ready (no se puede volver atras)
- pending_merge → (fuera) (un PR abierto no desaparece)

### 15.6 Saga

**Donde:** El flujo completo del pipeline es una transaccion de larga duracion con multiples pasos que pueden fallar.

**Que resuelve:** Cada paso tiene una accion de compensacion. Si algo falla a mitad del camino, el sistema sabe como revertir o limpiar.

```
Paso                              Compensacion si falla
───────────────────────────────   ───────────────────────────────
1. Sandbox container (Podman)     → containerManager.cleanup(worktreePath, requestId)
   (OBLIGATORIO: copiar archivos,    (sandbox es requisito — si falla, pipeline no corre)
    git clone, createSpawnFn)
2. Containers de proyecto         → stopContainers() + cdp.dispose()
   (OPCIONAL: compose up,            Fallo es NO-FATAL: pipeline continua sin browser tools
    health check, CDP browser)
3. Correr agentes                 → Emitir pipeline.error, limpiar sandbox + containers
   (dentro del sandbox via           (agente corre en /workspace dentro del container)
    podman exec)
4. Auto-correccion                → git reset al commit pre-correccion
5. Merge back a rama original     → Mantener pipeline/{branch} para debug
6. Crear rama integration/        → Eliminar rama integration/{branch}
7. Crear PR                       → (sin compensacion — el PR es visible)
8. PR mergeado (humano)           → (irreversible — compensar con revert commit)
9. Cleanup ramas + containers     → Reintentar en proximo ciclo del Director
```

**Implementacion:** El Core mantiene un log de pasos completados para cada `request_id`. Si el proceso se interrumpe (crash, timeout), al reiniciar puede:
- Ver en que paso se quedo
- Ejecutar la compensacion de los pasos completados
- O retomar desde donde se quedo

```
.pipeline/sagas/{request_id}.json
{
  "request_id": "abc-123",
  "steps_completed": ["create_branch", "run_agents", "auto_correct", "merge_back"],
  "current_step": "create_integration_branch",
  "started_at": "2026-02-14T12:00:00Z"
}
```

### 15.7 Idempotencia

**Donde:** Inbound adapters — antes de aceptar un request, verificar si ya existe uno para la misma rama.

**Que resuelve:** Si un cliente manda el mismo branch dos veces (doble click, retry, webhook duplicado), el sistema no crea dos pipelines.

```
POST /pipeline/run { branch: "feature/auth" }

Inbound Adapter:
  1. ¿Hay un pipeline activo para "feature/auth"?
     → Si: devolver el request_id existente (200 OK, no 202)
     → No: crear nuevo pipeline (202 Accepted)
```

```
POST /pipeline/run { branch: "feature/auth" }
→ 202 Accepted { request_id: "abc-123" }       ← primera vez

POST /pipeline/run { branch: "feature/auth" }
→ 200 OK { request_id: "abc-123",              ← duplicado detectado
           status: "already_running",
           events_url: "/pipeline/abc-123/events" }
```

**Clave de idempotencia:** `branch` + estado activo (running o pending_merge). Si la rama ya esta en `merge_history`, un nuevo request es valido (puede haber nuevos commits).

### 15.8 Circuit Breaker

**Donde:** Outbound adapters y dependencias externas (GitHub API, Claude Code).

**Que resuelve:** Si GitHub esta caido, el Integrador no deberia quedarse intentando crear PRs indefinidamente. Si Claude Code falla, el Core no deberia acumular una cola infinita.

```
Estado del circuit:

CLOSED (normal)     → Las llamadas pasan normalmente
  │
  │  N fallos consecutivos
  ▼
OPEN (cortado)      → Las llamadas fallan inmediatamente sin intentar
  │                   Se emite evento de degradacion
  │  Despues de timeout
  ▼
HALF-OPEN (prueba)  → Se permite UNA llamada de prueba
  │
  ┌┴┐
  │ │
 ✅ ❌
  │ │
  ▼ ▼
CLOSED  OPEN
```

**Circuits en el sistema:**

| Dependencia | Consecuencia cuando OPEN | Recuperacion |
|---|---|---|
| **Claude Code** | Pipeline requests se encolan, no se ejecutan | Al cerrar, procesar cola |
| **GitHub API** | PRs no se crean, ramas quedan en `ready` | Director reintenta en proximo ciclo |
| **Webhook cliente** | Eventos se guardan en DLQ | Reintentar cuando el cliente vuelva |

```yaml
# Configuracion
resilience:
  circuit_breaker:
    claude_code:
      failure_threshold: 3          # Abrir despues de 3 fallos consecutivos
      reset_timeout_seconds: 60     # Probar de nuevo despues de 60s
    github_api:
      failure_threshold: 5
      reset_timeout_seconds: 120
    webhooks:
      failure_threshold: 3
      reset_timeout_seconds: 30
```

### 15.9 Dead Letter Queue (DLQ)

**Donde:** Outbound adapters — cuando un webhook o notificacion falla.

**Que resuelve:** Los eventos no se pierden cuando un adapter externo falla. Se guardan para reintento.

```
Event Bus → Webhook Adapter → POST al cliente
                  │
                  ├── ✅ 200 OK → evento entregado
                  │
                  └── ❌ timeout / 500 / connection refused
                           │
                           ▼
                     Dead Letter Queue
                     .pipeline/dlq/{adapter}/{request_id}.jsonl
                           │
                           ▼
                     Retry con backoff exponencial:
                       1er intento: 5s
                       2do intento: 15s
                       3er intento: 45s
                       4to intento: 135s
                       max: 5 intentos
                           │
                     ┌─────┴─────┐
                     │           │
                  ✅ Entregado  ❌ Agotado
                     │           │
                  Eliminar    Emitir evento:
                  de DLQ      adapter.delivery.failed
                              (requiere atencion manual)
```

```yaml
# Configuracion
resilience:
  dead_letter:
    enabled: true
    path: ".pipeline/dlq/"
    max_retries: 5
    backoff: "exponential"          # linear | exponential
    base_delay_seconds: 5
```

**Diferencia con la persistencia de eventos:** La persistencia (`.pipeline/events/*.jsonl`) es para auditoria — guarda todos los eventos. La DLQ es para reintentos — solo guarda los que fallaron.

---

## 16. Principios de Diseno

1. **Pipeline Service autonomo** — El Service corre como un proceso independiente. Los clientes solo hacen HTTP requests. No spawnean procesos, no gestionan agentes, no saben como funciona internamente.

2. **Clientes simples** — Cualquier servicio web solo necesita hacer un POST y exponer un webhook para recibir notificaciones. Tres funciones de codigo nuevo. Nada mas.

3. **Hexagonal (Ports & Adapters)** — Los adapters viven dentro del Service. Agregar un nuevo destino (Discord, Jira, email) es agregar un modulo al Service. Cero cambios al Core, cero cambios a los clientes.

4. **Event-driven** — Toda comunicacion entre componentes internos es via eventos. El Event Bus es el sistema nervioso. La comunicacion con clientes externos es via HTTP (webhooks o SSE).

5. **Rama de pipeline** — Las correcciones automaticas ocurren en `pipeline/{branch}`, protegiendo la rama original del desarrollador.

6. **Metadata opaca** — El Core no interpreta `metadata`. Lo recibe, lo pasa en cada evento, y los adapters lo usan para correlacionar. Esto mantiene al Core desacoplado.

7. **Los worktrees son gestionados externamente** — El pipeline no crea ni destruye worktrees. Los recibe como input. El cliente es responsable de gestionarlos.

8. **El Director no adivina** — No escanea worktrees. Lee un manifiesto explicito que le dice cuales estan listos. Reacciona a eventos, no hace polling.

9. **Agentes por tier** — El pipeline clasifica el cambio (Small/Medium/Large) y ejecuta 2, 5, u 8 agentes segun el impacto. Tests y Security siempre corren. El tier puede escalar si un agente detecta un problema grave.

10. **Un agente orquesta el pipeline** — Un solo agente en el Core lanza los 8 subagentes y consolida. No hay 8 procesos sueltos.

11. **Correctivo, no solo detectivo** — El sistema corrige problemas automaticamente, no solo los reporta. Las correcciones se hacen en la rama de pipeline.

12. **Solo los aprobados llegan al manifiesto** — Si el pipeline falla y no se puede auto-corregir, el manifiesto no se toca. El Director nunca ve ramas con problemas.

13. **Integracion via Pull Request** — El Integrador no mergea directamente a main. Crea Pull Requests con resumen completo del pipeline, dando visibilidad y control humano. Resuelve conflictos semanticamente y deduplica codigo entre ramas antes de abrir el PR.

14. **Paralelo en todos los niveles** — Multiples pipelines corren en paralelo. Los 8 agentes del pipeline corren en paralelo. Los merges son secuenciales (por necesidad).

15. **Sandbox obligatorio, containers de proyecto opcionales** — Cada pipeline **siempre** corre dentro de un sandbox container Podman (Podman es requisito obligatorio — sin el, el pipeline falla). Los archivos del worktree se copian al container y se inicializa un repo git fresco (copy + clone, no bind-mount). Adicionalmente, si el proyecto tiene `compose.yml`, se levantan containers de proyecto con browser tools CDP (degradacion graceful si falla). Los agentes reciben herramientas de browser (`cdp_navigate`, `cdp_screenshot`, `cdp_get_dom`) via MCP solo cuando hay containers de proyecto.

16. **Post-merge pipeline** — Despues de cada merge a main, se re-ejecuta el pipeline para verificar que la integracion no rompio nada.

17. **Dependencias entre ramas** — El Director detecta si una rama depende de otra y no la mergea hasta que su dependencia este en main.

18. **Trazabilidad completa** — Cada evento se persiste. Se puede reconstruir la historia completa de cualquier pipeline. Cada correccion tiene un commit dedicado.

19. **Extensible sin modificar** — Nuevos outbound adapters (Discord, Jira, email) se agregan como modulos al Service. Cero cambios al Core, cero cambios a los clientes existentes.

---

## Apendice A: Decisiones de Implementacion

Este apendice documenta las decisiones tomadas durante la implementacion que divergen del diseno original descrito arriba. El SAD describe la arquitectura ideal; esta seccion describe lo que se implemento y por que.

### A.1 Nombres de agentes simplificados

**SAD (§7):** 8 agentes nombrados: `tests`, `security`, `architecture`, `performance`, `dependencies`, `code_quality`, `accessibility`, `documentation`.

**Implementacion:** 8 agentes con nombres diferentes:

| SAD | Implementacion | Razon |
|-----|----------------|-------|
| `tests` | `tests` | Sin cambio |
| `security` | `security` | Sin cambio |
| `architecture` | `architecture` | Sin cambio |
| `performance` | `performance` | Sin cambio |
| `dependencies` | *(absorbido en `types`)* | La verificacion de dependencias se integro en el agente de tipos |
| `code_quality` | `style` | Nombre mas descriptivo para linting y estilo de codigo |
| `accessibility` | `types` | Reemplazado por verificacion de tipos (TypeScript) por ser mas relevante en proyectos backend |
| `documentation` | `docs` | Nombre abreviado |
| *(nuevo)* | `integration` | Agente de verificacion de integracion (solo en tier Large) |

### A.2 Agentes por tier simplificados

**SAD (§7.0):** Small = `[tests, security]`, Medium = `[+architecture, +dependencies, +code_quality]`, Large = `[+performance, +accessibility, +documentation]`.

**Implementacion:**
- **Small** (2): `[tests, style]` — `security` se movio a Medium por ser costoso para cambios triviales
- **Medium** (5): `[tests, security, architecture, style, types]`
- **Large** (8): `[tests, security, architecture, performance, style, types, docs, integration]`

### A.3 Auto-correccion: 2 intentos en lugar de 3

**SAD (§10):** "Maximo 3 intentos".

**Implementacion:** `max_attempts: 2` por defecto. Configurable via `.pipeline/config.yaml`.

**Razon:** Con Claude Opus, 2 intentos son suficientes en la practica. Si el agente no puede corregir en 2 intentos, es probable que el problema requiera intervencion humana. Reduce costo y tiempo de ejecucion.

### A.4 Pipeline post-merge no implementado

**SAD (§9, §15.6):** "Re-ejecutar pipeline sobre el resultado del merge para verificar integridad" — despues de que el Integrador mergea `pipeline/{branch}` en `integration/{branch}`, se re-ejecuta el pipeline completo sobre el resultado.

**Implementacion:** El Integrador **no** re-ejecuta el pipeline post-merge. Despues del merge (con o sin conflictos resueltos), procede directamente a push + crear PR.

**Razon:** Re-ejecutar el pipeline completo duplica el costo y tiempo de cada integracion. La verificacion de integridad se delega al CI/CD del repositorio (GitHub Actions, etc.) que corre sobre el PR. Si en el futuro se necesita, se puede agregar como un paso opcional en la saga del Integrador.

### A.5 Configuracion simplificada

**SAD (§12):** Configuracion granular con per-agent `enabled`/`blocking`/`tier`/`condition` flags, multiples backends de Event Bus (`local`/`redis`/`nats`), modos de integracion (`pull-request`/`auto-merge`), y configuracion detallada de adapters inbound/outbound.

**Implementacion (Zod schema):** Configuracion simplificada en 11 secciones:

| SAD | Implementacion | Nota |
|-----|----------------|------|
| Per-agent `enabled`/`blocking` flags | Tier-based agent arrays (`tiers.small.agents`) | Mas simple; los agents se activan/desactivan por tier |
| `event_bus.implementation: redis/nats` | Solo EventEmitter (in-memory + JSONL) | Suficiente para single-machine; Redis/NATS se agregaria si se necesita multi-maquina |
| `integration.mode: pull-request/auto-merge` | Solo `pull-request` | El merge final a main siempre requiere aprobacion humana |
| `adapters.inbound` (REST, CLI, MCP, webhook) | Solo REST API (Hono) | CLI y MCP se agregan via integracion con `@a-parallel/server` |
| `adapters.outbound` (manifest, client, slack, github) | `adapters.webhooks[]` generico | Un solo tipo de adapter (webhook) cubre todos los casos; adapters especificos se agregan segun demanda |
| `logging.per_request`, `.sources`, `.retention_days` | Solo `logging.level` | Pino logger con nivel configurable; la persistencia es via EventBus JSONL |

### A.6 Stack tecnologico

**SAD (§13):** "Aplicacion Node.js (Express/Fastify)" con procesos Claude Code spawneados como subprocesses (`claude -p "..."`).

**Implementacion:**
- **Runtime:** Bun (no Node.js) — mas rapido, menos dependencias
- **HTTP Framework:** Hono (no Express/Fastify) — mas ligero, edge-ready
- **Agent SDK:** `@a-parallel/core/agents` que usa `AgentOrchestrator` + `SDKClaudeProcess` (Claude Agent SDK, no CLI subprocess)
- **Git operations:** `@a-parallel/core/git` que usa `execute()` via `Bun.spawn` (no `execa` ni `child_process`)
- **Port:** `3002` (no `3100` como dice el SAD) — para evitar conflictos con el server principal en `3001`
- **Monorepo package:** `@a-parallel/agent` dentro del workspace de `a-parallel`

### A.7 Saga: 7 pasos en lugar de 9

**SAD (§15.6):** 9 pasos de saga con compensaciones (incluyendo pipeline post-merge y cleanup de ramas).

**Implementacion del Integrator Saga:** 6 pasos operativos + 1 de restore:

| # | Paso | Compensacion |
|---|------|-------------|
| 1 | `fetch_main` | *(ninguna — idempotente)* |
| 2 | `create_integration_branch` | `git branch -D` + `git checkout main` |
| 3 | `merge_pipeline` | `git merge --abort` |
| 4 | `push_branch` | `git push origin --delete` |
| 5 | `create_pr` | *(ninguna — el PR es visible)* |
| 6 | `checkout_main` | *(ninguna)* |

**Diferencias:**
- Sin "Crear rama pipeline/{branch}" — la rama ya existe cuando llega al Integrador
- Sin "Pipeline post-merge" — no re-ejecutamos el pipeline (ver §A.4)
- Sin "Cleanup ramas" — cleanup es un proceso separado via `BranchCleaner`, no parte de la saga

### A.8 Branch cleanup como componente separado

**SAD (§9):** "El Director ejecuta la limpieza como parte de su ciclo".

**Implementacion:** `BranchCleaner` es un componente independiente que reacciona a eventos via el EventBus:
- `pipeline.completed` → elimina `pipeline/{branch}`
- `pipeline.failed` → mantiene o elimina segun `cleanup.keep_on_failure` config
- `integration.pr.merged` → elimina `pipeline/` + `integration/` (pendiente: requiere webhook de GitHub)

**Razon:** Separar cleanup del Director mantiene cada componente con una sola responsabilidad. El Director coordina integraciones; el BranchCleaner limpia ramas.

### A.9 Eventos: catalogo real vs SAD

**SAD (§3.2):** Eventos como `pipeline.branch.created`, `pipeline.agents.started`, `pipeline.round.completed`, `pipeline.correction.started`, `integration.pipeline.running`.

**Implementacion:** Catalogo simplificado con nombres consistentes:

```
Pipeline: accepted, started, containers.ready, tier_classified, agent.started,
          agent.completed, agent.failed, correcting, completed, failed, stopped, message
Director: activated, integration.dispatched, integration.pr_created,
          pr.rebase_needed, cycle.completed
Integration: started, conflict.detected, conflict.resolved, pr.created,
             pr.rebased, pr.rebase_failed, completed, failed
Cleanup: started, completed
```

Eventos **nuevos** en la implementacion (no en el SAD original):
- `pipeline.containers.ready` — emitido cuando el Paso 0 completa: containers levantados, health check OK, CDP browser listo

Eventos del SAD que **no existen** en la implementacion:
- `pipeline.branch.created` — la rama se crea implicitamente
- `pipeline.agents.started` — cada agente emite su propio `agent.started`
- `pipeline.round.completed` — no hay concepto de "rondas" (un solo agente orquesta)
- `pipeline.correction.started/completed` — se emite `pipeline.correcting` sin granularidad por agente
- `integration.pipeline.running` — no re-ejecutamos pipeline post-merge

### A.10 Container Infrastructure: Sandbox obligatorio + Browser Tools

**SAD (original):** No existia — los agentes solo hacian analisis estatico sin acceso a la aplicacion corriendo.

**Implementacion:** Se agrego un **Paso 0 de infraestructura** en el `PipelineRunner` con **dos capas**:

**Capa 1 — Sandbox (OBLIGATORIA):**
1. Verifica que Podman esta instalado (si no → error con instrucciones de instalacion)
2. Construye la imagen `a-parallel-sandbox` si no existe (lazy, una vez)
3. Crea un container `pipeline-sandbox-{requestId}` con el worktree montado **read-only** en `/mnt/source`
4. Copia archivos (excluyendo `.git`) del mount a `/workspace`
5. Inicializa un repo git fresco: `git init` → `git remote add origin` → `git fetch --depth=50` → `git checkout`
6. Crea un `spawnClaudeCodeProcess` que redirige el proceso Claude Code dentro del container via `podman exec`

**Capa 2 — Proyecto (OPCIONAL):**
7. Detecta si el worktree tiene un `compose.yml` (o variantes)
8. Si existe: levanta containers via Podman (`podman compose up -d`), espera health checks
9. Crea un servidor MCP con Playwright headless Chrome (tools: `cdp_navigate`, `cdp_screenshot`, `cdp_get_dom`)
10. Inyecta el MCP server y el `spawnClaudeCodeProcess` en `orchestrator.startAgent()`

**Arquitectura de paquetes:**
- `@a-parallel/core/containers` — Libreria reutilizable (`SandboxManager`, `ContainerService`, `createCdpMcpServer`)
- `@a-parallel/agent/infrastructure/container-manager.ts` — Orquestacion especifica del pipeline

**Estrategia Copy + Clone (por que no bind-mount):**
- Los worktrees de git usan un archivo `.git` pointer (no un directorio), y bind-mountear esto no funciona correctamente dentro de un container Linux
- Cross-platform: el host puede ser Windows, el container es Linux — los paths no son compatibles
- Permisos: bind-mounts heredan permisos del host, causando problemas con el usuario `sandbox` del container
- Solucion: copiar archivos + `git init` + `git fetch --depth=50` dentro del container

**Razon:** Los agentes corren en un entorno aislado y reproducible. Ademas, cuando hay containers de proyecto, pueden interactuar con la aplicacion corriendo para tests E2E, verificacion visual, accesibilidad (WCAG), y performance.

**Degradacion:** El sandbox es **obligatorio** — sin Podman el pipeline no corre. Los containers de proyecto son **opcionales** — si falla su setup (compose no existe, health timeout, Playwright falla), el pipeline continua con el sandbox pero sin browser tools.

### A.11 Eventos `pipeline.cli_message` para renderizado en la UI

**SAD (original):** Los eventos del pipeline son solo de lifecycle (started, completed, failed, etc.).

**Implementacion:** El `PipelineRunner` emite **dos flujos de eventos** en paralelo:

1. **`pipeline.cli_message`** — Cada `CLIMessage` raw del agente se reenvía como evento. Contiene el JSON completo del mensaje (tool calls, bash output, texto del asistente, etc.). Estos eventos llegan a la UI principal via el ingest webhook (ver §A.12) y se renderizan exactamente como los mensajes de un thread normal.

2. **Eventos de lifecycle** — Los eventos tipados (`pipeline.started`, `pipeline.completed`, etc.) generados por el `PipelineEventMapper`. Se usan internamente para el Manifest Writer, idempotency release, Director auto-trigger, branch cleanup, y container cleanup.

```
CLIMessage del agente
         │
         ├──→ pipeline.cli_message (SIEMPRE) → EventBus → Ingest Webhook → UI
         │
         └──→ PipelineEventMapper.map() (CONDICIONAL) → Evento de lifecycle
```

**Razon:** La UI necesita mostrar el output completo del agente (tool cards, bash output, etc.) tal cual aparece en un thread normal. Los eventos de lifecycle son demasiado abstractos para renderizar una vista detallada.

### A.12 Ingest webhook para forwarding de eventos a la UI

**SAD (original):** Los outbound adapters se configuran manualmente en `.pipeline/config.yaml`.

**Implementacion:** Se registra automaticamente un webhook adapter interno que reenvia **todos** los eventos del pipeline al endpoint `/api/ingest/webhook` del server principal (`@a-parallel/server`). Esto permite que los eventos del pipeline (incluyendo `pipeline.cli_message`) aparezcan en la UI de a-parallel.

```
EventBus
   │
   ├── Webhook Adapters (configurados por el usuario)
   │
   └── Ingest Webhook (auto-registrado)
       → POST {INGEST_WEBHOOK_URL}/api/ingest/webhook
       → Default: http://localhost:3001/api/ingest/webhook
```

**Variables de entorno:**
- `INGEST_WEBHOOK_URL` — URL completa del endpoint de ingest (default: `http://localhost:{SERVER_PORT}/api/ingest/webhook`)
- `INGEST_WEBHOOK_SECRET` — Secret compartido para autenticacion HMAC (opcional)
- `SERVER_PORT` — Puerto del server principal como fallback para construir la URL (default: `3001`)

**Razon:** Sin este webhook, el pipeline corre como un servicio aislado y sus eventos no aparecen en la UI. El auto-registro asegura que la integracion funciona out-of-the-box sin configuracion extra.

### A.13 Eventos adicionales no documentados en el SAD original

La implementacion agrego varios eventos que no estaban en el catalogo original:

| Evento | Cuando se emite | Nota |
|--------|----------------|------|
| `pipeline.accepted` | Al recibir el PipelineRequest, antes de clasificar tier | Permite a la UI mostrar inmediatamente que el pipeline fue aceptado |
| `pipeline.tier_classified` | Despues de clasificar el tier | Informa tier y stats del diff |
| `pipeline.stopped` | Cuando se detiene un pipeline manualmente (POST /:id/stop) | Diferente de `failed` — fue detenido intencionalmente |
| `pipeline.cli_message` | Con cada CLIMessage del agente | Ver §A.11 |
| `pipeline.message` | Texto libre del pipeline | Tipo generico para mensajes informativos |
| `cleanup.started` / `cleanup.completed` | Al iniciar/terminar limpieza de ramas | Emitidos por BranchCleaner |
