const { defineConfig } = require('vite');
const vue = require('@vitejs/plugin-vue');

// https://vitejs.dev/config/
module.exports = defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // Proxy all requests to the backend
      '/api/': {
        target: 'https://avalon.onl',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    // Output to server dist folder
    outDir: '../server/dist',
    emptyOutDir: true,
  },
});
