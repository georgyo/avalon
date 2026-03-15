// vite.config.js

import { defineConfig } from 'vite'
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";

import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'https://avalon.onl',
        changeOrigin: true,
      }
    }
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
  optimizeDeps: {
    include: ['@avalon/common', '@avalon/common/avalonlib', 'vue', 'vuetify'],
  },
})
