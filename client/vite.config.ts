// vite.config.ts

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import eslint from 'vite-plugin-eslint'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vuetify({
      autoImport: true,
    }),
    eslint({
      cache: false,
      include: ['src/**/*.js', 'src/**/*.vue', 'src/**/*.ts'],
      exclude: ['node_modules', 'dist'],
    }),
  ],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    alias: {
      "@": fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: [],
    esbuildOptions: {
      // Disable source maps for dependencies to avoid warnings
      sourcemap: false,
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'https://avalon.onl',
        changeOrigin: true,
        secure: true,
      }
    }
  }
})
