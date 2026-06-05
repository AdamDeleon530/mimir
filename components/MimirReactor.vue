<script setup lang="ts">
interface Props {
  state: 'idle' | 'listening' | 'transcribing' | 'consulting' | 'speaking'
  intensity?: number  // 0–1, optional audio level for amplitude-driven scale
}
const props = withDefaults(defineProps<Props>(), { intensity: 0 })

// Subtle CSS variable to drive amplitude from JS if/when we wire real audio analysis
const reactorStyle = computed(() => ({
  '--reactor-intensity': props.intensity.toFixed(3),
}))
</script>

<template>
  <div :class="['reactor', `reactor--${state}`]" :style="reactorStyle">
    <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" class="reactor__svg" aria-hidden="true">
      <defs>
        <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#d4b25c" stop-opacity="0.9" />
          <stop offset="40%" stop-color="#c9a64a" stop-opacity="0.5" />
          <stop offset="100%" stop-color="#c9a64a" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="auraGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#c9a64a" stop-opacity="0.18" />
          <stop offset="60%" stop-color="#c9a64a" stop-opacity="0.05" />
          <stop offset="100%" stop-color="#c9a64a" stop-opacity="0" />
        </radialGradient>
      </defs>

      <!-- Soft outer aura -->
      <circle cx="200" cy="200" r="195" fill="url(#auraGlow)" class="reactor__aura" />

      <!-- Outer ring with runic tick marks -->
      <g class="reactor__ring reactor__ring--outer">
        <circle cx="200" cy="200" r="180" />
        <g class="reactor__ticks">
          <line v-for="i in 24" :key="i" x1="200" y1="20" x2="200" y2="32"
            :transform="`rotate(${i * 15} 200 200)`" />
        </g>
      </g>

      <!-- Mid rings -->
      <circle cx="200" cy="200" r="145" class="reactor__ring reactor__ring--2" />
      <circle cx="200" cy="200" r="115" class="reactor__ring reactor__ring--3" />
      <circle cx="200" cy="200" r="88"  class="reactor__ring reactor__ring--4" />

      <!-- Spinning pip on outer ring (state indicator) -->
      <g class="reactor__pip">
        <circle cx="200" cy="20" r="3" />
      </g>

      <!-- Inner core glow -->
      <circle cx="200" cy="200" r="65" fill="url(#coreGlow)" class="reactor__core-glow" />

      <!-- Sound wave bars (visible in speaking/listening states) -->
      <g class="reactor__waves">
        <rect v-for="i in 5" :key="i"
          :x="180 + (i - 1) * 10" y="195"
          width="4" height="10"
          rx="1"
          :style="`--bar-i: ${i}`"
        />
      </g>

      <!-- Nauthiz N rune in dead center -->
      <g class="reactor__rune">
        <line x1="186" y1="178" x2="186" y2="222" />
        <line x1="214" y1="178" x2="214" y2="222" />
        <line x1="186" y1="178" x2="214" y2="222" />
      </g>

      <!-- Expanding pulse ring (animated on speak/listen) -->
      <circle cx="200" cy="200" r="80" class="reactor__pulse-ring" />
    </svg>
  </div>
</template>

<style scoped>
.reactor {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  max-width: 460px;
  margin: 0 auto;
  --gold: #c9a64a;
  --gold-bright: #d4b25c;
  --gold-dim: #8b7045;
}
.reactor__svg { width: 100%; height: 100%; overflow: visible; }

/* === Base ring styles === */
.reactor__ring circle,
.reactor__ring--2,
.reactor__ring--3,
.reactor__ring--4 {
  fill: none;
  stroke: var(--gold);
  stroke-width: 1;
  opacity: 0.45;
  transform-origin: 200px 200px;
}
.reactor__ring--outer circle { stroke-width: 1.5; opacity: 0.55; }
.reactor__ring--2 { stroke-width: 1.2; opacity: 0.5; }
.reactor__ring--3 { stroke-width: 1; opacity: 0.4; }
.reactor__ring--4 { stroke-width: 0.8; opacity: 0.3; }

.reactor__ticks line {
  stroke: var(--gold);
  stroke-width: 1;
  opacity: 0.6;
}

.reactor__pip circle {
  fill: var(--gold-bright);
  filter: drop-shadow(0 0 4px var(--gold));
  transform-origin: 200px 200px;
  animation: reactor-spin 24s linear infinite;
}

.reactor__core-glow {
  opacity: 0.65;
  transform-origin: 200px 200px;
}

.reactor__rune line {
  stroke: var(--gold-bright);
  stroke-width: 2.5;
  stroke-linecap: square;
  filter: drop-shadow(0 0 4px var(--gold));
}

.reactor__pulse-ring {
  fill: none;
  stroke: var(--gold);
  stroke-width: 1.5;
  opacity: 0;
  transform-origin: 200px 200px;
}

.reactor__waves rect {
  fill: var(--gold-bright);
  opacity: 0;
  transform-origin: center;
  filter: drop-shadow(0 0 3px var(--gold));
}

/* === IDLE — slow ambient breathing === */
.reactor--idle .reactor__ring--2 { animation: reactor-breathe 7s ease-in-out infinite; }
.reactor--idle .reactor__ring--3 { animation: reactor-breathe 7s ease-in-out infinite 0.6s; }
.reactor--idle .reactor__ring--4 { animation: reactor-breathe 7s ease-in-out infinite 1.2s; }
.reactor--idle .reactor__core-glow { animation: reactor-core-pulse 5s ease-in-out infinite; }

/* === LISTENING — quicker pulse, brighter === */
.reactor--listening .reactor__ring--outer circle { animation: reactor-throb 1.6s ease-in-out infinite; }
.reactor--listening .reactor__ring--2 { animation: reactor-throb 1.6s ease-in-out infinite 0.15s; }
.reactor--listening .reactor__ring--3 { animation: reactor-throb 1.6s ease-in-out infinite 0.3s; }
.reactor--listening .reactor__ring--4 { animation: reactor-throb 1.6s ease-in-out infinite 0.45s; }
.reactor--listening .reactor__core-glow { animation: reactor-core-pulse 1.6s ease-in-out infinite; }
.reactor--listening .reactor__waves rect {
  animation: reactor-wave-listen 0.9s ease-in-out infinite;
  animation-delay: calc(var(--bar-i) * 0.08s);
}

/* === SPEAKING — full bloom, expanding waves === */
.reactor--speaking .reactor__ring--outer circle,
.reactor--speaking .reactor__ring--2,
.reactor--speaking .reactor__ring--3,
.reactor--speaking .reactor__ring--4 { opacity: 0.7; }
.reactor--speaking .reactor__core-glow { opacity: 0.95; animation: reactor-core-pulse 0.9s ease-in-out infinite; }
.reactor--speaking .reactor__waves rect {
  animation: reactor-wave-speak 0.7s ease-in-out infinite;
  animation-delay: calc(var(--bar-i) * 0.06s);
}
.reactor--speaking .reactor__pulse-ring {
  animation: reactor-expand 1.8s ease-out infinite;
}
.reactor--speaking .reactor__rune line {
  animation: reactor-rune-glow 1.5s ease-in-out infinite;
}

/* === TRANSCRIBING / CONSULTING — rotating outer ring, dim core === */
.reactor--transcribing .reactor__ticks,
.reactor--consulting .reactor__ticks {
  animation: reactor-spin 3s linear infinite;
  transform-origin: 200px 200px;
}
.reactor--transcribing .reactor__core-glow,
.reactor--consulting .reactor__core-glow {
  animation: reactor-core-pulse 2.2s ease-in-out infinite;
}

/* === KEYFRAMES === */
@keyframes reactor-breathe {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50%      { opacity: 0.6; transform: scale(1.015); }
}
@keyframes reactor-throb {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50%      { opacity: 0.85; transform: scale(1.04); }
}
@keyframes reactor-core-pulse {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50%      { opacity: 0.95; transform: scale(1.08); }
}
@keyframes reactor-expand {
  0%   { r: 70; opacity: 0.7; }
  100% { r: 180; opacity: 0; }
}
@keyframes reactor-spin {
  to { transform: rotate(360deg); }
}
@keyframes reactor-wave-listen {
  0%, 100% { opacity: 0.3; transform: scaleY(0.6); }
  50%      { opacity: 0.9; transform: scaleY(1.5); }
}
@keyframes reactor-wave-speak {
  0%, 100% { opacity: 0.5; transform: scaleY(0.8); }
  50%      { opacity: 1;   transform: scaleY(2.4); }
}
@keyframes reactor-rune-glow {
  0%, 100% { filter: drop-shadow(0 0 3px #c9a64a); }
  50%      { filter: drop-shadow(0 0 12px #d4b25c); }
}

@media (prefers-reduced-motion: reduce) {
  .reactor *, .reactor *::before, .reactor *::after {
    animation: none !important;
  }
}
</style>
