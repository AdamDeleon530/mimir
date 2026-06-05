// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'Mimir — The Nordic Nerd',
      htmlAttrs: { lang: 'en' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Operational lens for The Nordic Nerd.' },
        { name: 'theme-color', content: '#07090f' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap' },
      ],
    },
  },
  runtimeConfig: {
    // server-only secrets — never exposed to client
    anthropicApiKey: '',
    elevenlabsApiKey: '',
    elevenlabsVoiceId: 'nPczCjzI2devNBz1zQrb', // default: "Brian" — calm, considered. Override via env.
    elevenlabsModelId: 'eleven_flash_v2_5', // ~75ms latency. English-focused. Swap to eleven_multilingual_v2 if quality matters more than speed, or eleven_turbo_v2_5 for the middle ground.
    appPassword: '',
    public: {
      // client-safe config
      voiceFallback: 'browser', // 'browser' | 'none'
    },
  },
  nitro: {
    preset: 'vercel',
  },
})
