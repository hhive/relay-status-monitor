import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Sub2API 文档',
  description: 'Sub2API AI API 网关文档',
  lang: 'zh-CN',
  base: '/docs/',
  outDir: '../public/docs',
  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/overview' },
      { text: 'API', link: '/api/overview' },
      { text: '部署', link: '/ops/deployment' },
    ],
    sidebar: {
      '/guide/': [{ text: '指南', items: [{ text: '项目概览', link: '/guide/overview' }] }],
      '/api/': [{ text: 'API', items: [{ text: 'API 使用', link: '/api/overview' }] }],
      '/ops/': [{ text: '运维', items: [{ text: '部署指南', link: '/ops/deployment' }] }],
    },
    search: { provider: 'local' },
  },
})
