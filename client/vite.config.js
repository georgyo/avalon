// vite.config.js

import { defineConfig } from 'vite'
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";

import path from "path";

// The relay (server/server.ts) serves the GUN websocket on /gun and /api/relay-info. In development
// both are proxied to a locally running relay (`yarn start`, port 8001); the e2e stack
// (tests/e2e-stack.mjs) points VITE_RELAY_TARGET / VITE_API_TARGET at its throwaway relay.
const RELAY_TARGET = process.env.VITE_RELAY_TARGET || 'http://127.0.0.1:8001';
const API_TARGET = process.env.VITE_API_TARGET || RELAY_TARGET;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
  ],
  server: {
    proxy: {
      '/gun': {
        target: RELAY_TARGET,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    }
  },
  // client/src/p2p/crypto.worker.ts is a module worker (docs/p2p-protocol.md §7.5)
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../server/dist',
    emptyOutDir: true,
  },
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ['vue', 'vuetify'],
  },
  // @avalon/common is source-only TypeScript (§11.1): Vite compiles it like the app's own sources, so it
  // must not be pre-bundled. gun ships CommonJS/UMD and is pre-bundled for ESM interop.
  optimizeDeps: {
    include: ['vue', 'vuetify', 'gun', 'gun/sea'],
  },
})
