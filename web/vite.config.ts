import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080' },
    },
  },
  test: {
    // экранные тесты (RTL) лежат рядом с чистыми: браузерное окружение нужно
    // им всем, а jsdom стоит миллисекунды
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    restoreMocks: true,
  },
})
