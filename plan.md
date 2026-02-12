# Plan: Terminal interactivo con xterm.js via WebSocket

## Resumen
Añadir un terminal interactivo (PTY) al panel de terminal web, usando `node-pty` en el servidor y `xterm.js` (ya instalado) en el cliente, comunicándose por WebSocket.

## Cambios

### 1. Instalar `node-pty` en el servidor
- `npm install node-pty --workspace=packages/server`
- Es la librería estándar para PTY en Node/Bun. Permite crear shells interactivos (powershell/bash) con stdin/stdout bidireccional.

### 2. Crear servicio `pty-manager.ts` en el servidor
**Archivo:** `packages/server/src/services/pty-manager.ts`
- Mantiene un `Map<string, IPty>` de PTY activos por ID
- `spawnPty(id, cwd, cols, rows)` — crea un PTY (powershell en Windows, bash/sh en Linux/Mac)
- `writePty(id, data)` — envía input del usuario al PTY
- `resizePty(id, cols, rows)` — redimensiona
- `killPty(id)` — mata el proceso
- Emite datos del PTY al cliente via `wsBroker` usando eventos `pty:data` y `pty:exit`

### 3. Añadir eventos WebSocket para PTY
**Archivo:** `packages/shared/src/types.ts`
- Añadir tipos `WSPtyDataEvent` y `WSPtyExitEvent` al union `WSEvent`

### 4. Manejar mensajes del cliente en el WebSocket del servidor
**Archivo:** `packages/server/src/index.ts`
- En el handler `message()` del WebSocket (actualmente vacío), parsear mensajes JSON del cliente:
  - `pty:spawn` → llamar `ptyManager.spawnPty()`
  - `pty:data` → llamar `ptyManager.writePty()` (input del teclado)
  - `pty:resize` → llamar `ptyManager.resizePty()`
  - `pty:kill` → llamar `ptyManager.killPty()`

### 5. Manejar eventos PTY en el cliente
**Archivo:** `packages/client/src/hooks/use-ws.ts`
- Añadir cases para `pty:data` y `pty:exit` en `handleMessage()`
- `pty:data` → escribir datos al terminal xterm.js via el store
- `pty:exit` → marcar el tab como salido
- Exportar `getActiveWS()` para que los componentes puedan enviar mensajes al servidor

### 6. Actualizar `terminal-store.ts`
**Archivo:** `packages/client/src/stores/terminal-store.ts`
- Añadir un sistema de callbacks para PTY data (xterm necesita recibir datos directamente)
- Añadir campo `type: 'pty' | 'command'` al `TerminalTab` para diferenciar

### 7. Crear componente `WebTerminalTab` en `TerminalPanel.tsx`
**Archivo:** `packages/client/src/components/TerminalPanel.tsx`
- Nuevo componente que usa xterm.js (similar a `TauriTerminalTabContent` pero sobre WebSocket)
- Al montar: enviar `pty:spawn` al servidor via WebSocket
- `terminal.onData()` → enviar `pty:data` al servidor
- `terminal.onResize()` → enviar `pty:resize` al servidor
- Suscribirse a datos del PTY desde el store para escribir a xterm.js
- Al desmontar: enviar `pty:kill`

### 8. Actualizar botón del header para crear tab PTY
**Archivo:** `packages/client/src/components/thread/ProjectHeader.tsx`
- Cuando se hace click en el botón de terminal y no hay tabs, crear un tab PTY automáticamente

### 9. Mostrar botón "+" para nuevos terminales en modo web
**Archivo:** `packages/client/src/components/TerminalPanel.tsx`
- El botón "+" actualmente está condicionado a `isTauri`. Mostrar también en modo web.

## Flujo de datos
```
[xterm.js] → onData → ws.send({type:'pty:data', id, data}) → [server] → pty.write(data)
[server] pty.onData → wsBroker.emit({type:'pty:data', id, data}) → [client] → xterm.write(data)
```
