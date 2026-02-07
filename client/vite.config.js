// vite.config.js

import { defineConfig } from 'vite'
import { createVuePlugin as vue } from "vite-plugin-vue2";

const path = require("path");

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
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
    commonjsOptions: {
      include: [/common/, /node_modules/],
      transformMixedEsModules: true,
    },
  },
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "vue": require.resolve("vue/dist/vue.esm.js"),
    },
    dedupe: ['vue', 'vuetify'],
  },
  optimizeDeps: {
    include: ['@avalon/common', '@avalon/common/avalonlib', 'vue', 'vuetify'],
  },
})
