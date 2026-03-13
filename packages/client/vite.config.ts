import { resolve } from 'path';

import react from '@vitejs/plugin-react';
/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load env from both the monorepo root and the package dir (package-level overrides root)
  const monorepoRoot = resolve(__dirname, '../..');
  const env = { ...loadEnv(mode, monorepoRoot, ''), ...loadEnv(mode, process.cwd(), '') };
  const clientPort = Number(env.VITE_PORT) || 5173;
  const serverPort = Number(env.VITE_SERVER_PORT) || 3001;
  const serverUrl = env.VITE_SERVER_URL; // e.g. "https://funny-server.example.com"
  const runtimeTarget = `http://localhost:${serverPort}`;
  const proxyTarget = serverUrl || runtimeTarget;
  const wsProxyTarget = `ws://localhost:${serverPort}`;

  return {
    plugins: [
      react({
        jsxImportSource:
          mode === 'development' ? '@welldone-software/why-did-you-render' : undefined,
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/__tests__/setup.ts'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            markdown: ['react-markdown', 'remark-gfm'],
            motion: ['motion'],
            syntax: ['shiki'],
            monaco: ['@monaco-editor/react'],
            mermaid: ['mermaid'],
            tiptap: ['@tiptap/react', '@tiptap/core'],
          },
        },
      },
    },
    server: {
      host: env.VITE_HOST || 'localhost',
      port: clientPort,
      allowedHosts: true,
      proxy: {
        // When VITE_SERVER_URL is set (team mode), auth routes go to the central
        // server while everything else goes to the local runtime. This avoids
        // the need for a tunnel — the server never has to reach the runtime.
        ...(serverUrl
          ? {
              '/api/auth': {
                target: proxyTarget,
                changeOrigin: true,
                // Strip Secure flag from cookies so they work over http://localhost
                configure: (proxy: any) => {
                  proxy.on('proxyRes', (proxyRes: any) => {
                    const sc = proxyRes.headers['set-cookie'];
                    if (sc) {
                      proxyRes.headers['set-cookie'] = (Array.isArray(sc) ? sc : [sc]).map(
                        (c: string) =>
                          c
                            .replace(/;\s*Secure/gi, '')
                            .replace(/;\s*SameSite=None/gi, '; SameSite=Lax')
                            .replace(/;\s*Domain=[^;]*/gi, ''),
                      );
                    }
                  });
                },
              },
              '/api/bootstrap': {
                target: proxyTarget,
                changeOrigin: true,
              },
              '/api/runners': {
                target: proxyTarget,
                changeOrigin: true,
              },
            }
          : {}),
        '/api': {
          target: runtimeTarget,
          changeOrigin: true,
          // Timeout stale connections after 60s — must be generous enough for
          // slow git operations (commit with pre-commit hooks, push, PR creation).
          // Previously 10s which caused "Failed to fetch" on commits with hooks.
          timeout: 60_000,
        },
        '/ws': {
          target: wsProxyTarget,
          ws: true,
        },
      },
    },
  };
});
