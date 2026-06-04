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
        { name: 'theme-color', content: '#0a0a0a' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      ],
    },
  },
  runtimeConfig: {
    // server-only secrets — never exposed to client
    anthropicApiKey: '',
    elevenlabsApiKey: '',
    elevenlabsVoiceId: 'nPczCjzI2devNBz1zQrb', // default: "Brian" — calm, considered. Override via env.
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
