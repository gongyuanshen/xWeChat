import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    {
      // Nuxt replaces this flag in the browser build. Exercise the same mounted
      // animation and export paths in the annual-summary DOM lifecycle tests.
      name: 'wrapped-client-test',
      enforce: 'pre',
      transform(code, id) {
        if (!/\/(KeywordDictionarySpread|MonthlyCompanionPosters)\.vue$/.test(id.replaceAll('\\', '/'))) return
        return code.replaceAll('import.meta.client', 'true')
      },
    },
    vue(),
  ],
  resolve: {
    alias: [
      { find: '~', replacement: fileURLToPath(new URL('.', import.meta.url)) },
      { find: '@', replacement: fileURLToPath(new URL('.', import.meta.url)) },
    ]
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.js']
  }
})
