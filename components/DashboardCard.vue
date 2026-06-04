<script setup lang="ts">
interface Props {
  title: string
  accent?: 'gold' | 'red'
}
defineProps<Props>()
</script>

<template>
  <div
    class="glass rounded-xl p-5 animate-fade-in"
    :class="{
      'ring-1 ring-gold/30': accent === 'gold',
      'ring-1 ring-critred/30': accent === 'red',
    }"
  >
    <div class="text-[10px] uppercase tracking-[0.15em] text-offwhite/40 mb-3">{{ title }}</div>
    <slot />
  </div>
</template>
