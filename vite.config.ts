import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 4175,
    strictPort: true,
    host: '127.0.0.1',
    // 默认自动打开浏览器；设置 VITE_OPEN=0 可关闭（自动化截图/无头环境使用）
    open: process.env.VITE_OPEN !== '0',
    watch: {
      // 编辑器的原子写会在 src 里留下 .*.tmpdir / *.tmp，锁住时会让 watcher 抛 EBUSY
      // 直接崩掉整个 dev server（表现为页面打不开/黑屏）。这些一律不监听。
      ignored: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.tmp/**',
        '**/*.log',
        '**/.*.tmpdir/**',
        '**/.*.tmpdir',
        '**/*.tmp',
      ],
    },
  },
  preview: {
    port: 4175,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    chunkSizeWarningLimit: 2600,
    rollupOptions: {
      // 两个入口：index.html 是原本的微缩景观（屏幕零 UI），
      // proto.html 是《过街》游戏原型（带 HUD），互不干扰。
      input: {
        main: 'index.html',
        proto: 'proto.html',
      },
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
