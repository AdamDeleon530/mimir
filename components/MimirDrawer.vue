<script setup lang="ts">
interface AgencyStatus {
  asOf: string
  ops: { fileCount: number; syncedAt: string; isEmpty: boolean }
  money: { mtdRevenue: number | null; mrr: number | null; burnMTD: number | null; note?: string }
  pipeline: { stages: Array<{ name: string; count: number; value: number }>; note?: string }
  replies: { pending: number; note?: string }
  outbound: { bounceRate7d: number | null; complaintRate7d: number | null; inboxes: unknown[]; note?: string }
}

const props = defineProps<{
  status: AgencyStatus | null
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'refresh'): void
}>()

function close(): void { emit('update:modelValue', false) }
function toggle(): void { emit('update:modelValue', !props.modelValue) }

function dollars(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n)
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (!t) return 'never'
  const diffSec = Math.floor((Date.now() - t) / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

// Reactive motion target — slides in when open, out when closed
const drawerAnimation = computed(() => ({
  x: props.modelValue ? 0 : -280,
  transition: { type: 'spring', stiffness: 340, damping: 36 },
}))
</script>

<template>
  <!-- Backdrop (fades independently of the slide) -->
  <Transition name="fade">
    <div
      v-if="modelValue"
      class="fixed inset-0 z-[15] cursor-pointer"
      style="background: rgba(15,27,45,0.65); backdrop-filter: blur(2px);"
      aria-hidden="true"
      @click="close"
    />
  </Transition>

  <!-- Drawer panel (always mounted, position driven by v-motion) -->
  <div
    v-motion
    :initial="{ x: -280 }"
    :animate="drawerAnimation"
    class="fixed inset-y-0 left-0 z-[20] w-[280px] flex flex-col"
    style="background: #0b1525; border-right: 1px solid rgba(255,255,255,0.07);"
    role="complementary"
    aria-label="Agency status panels"
  >
    <!-- Drawer header -->
    <div class="drawer-head shrink-0">
      <span class="drawer-eyebrow">Agency Status</span>
      <button
        class="refresh-btn"
        title="Refresh"
        aria-label="Refresh agency status"
        @click="emit('refresh')"
      >↻</button>
    </div>

    <!-- Panels (scrollable) -->
    <div class="panels-scroll">

      <!-- ── Agency Pulse ── -->
      <section class="panel">
        <div class="panel-stripe" aria-hidden="true"></div>
        <div class="panel-head">
          <span class="panel-title">Agency Pulse</span>
        </div>
        <div class="panel-body space-y-4">
          <div>
            <p class="metric-label">MTD Revenue</p>
            <p class="metric-value text-[22px]">
              {{ status?.money?.mtdRevenue != null ? dollars(status.money.mtdRevenue) : '—' }}
            </p>
          </div>
          <div class="grid grid-cols-2 gap-3 pt-3 border-t" style="border-color: rgba(255,255,255,0.05);">
            <div>
              <p class="metric-label">MRR</p>
              <p class="metric-value">{{ status?.money?.mrr != null ? dollars(status.money.mrr) : '—' }}</p>
            </div>
            <div>
              <p class="metric-label">Burn MTD</p>
              <p class="metric-value">{{ status?.money?.burnMTD != null ? dollars(status.money.burnMTD) : '—' }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ── Outbound ── -->
      <section class="panel">
        <div class="panel-stripe" aria-hidden="true"></div>
        <div class="panel-head">
          <span class="panel-title">Outbound</span>
        </div>
        <div class="panel-body space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <p class="metric-label">Bounce 7d</p>
              <p class="metric-value">
                {{ status?.outbound?.bounceRate7d != null
                  ? status.outbound.bounceRate7d.toFixed(1) + '%'
                  : '—' }}
              </p>
            </div>
            <div>
              <p class="metric-label">Replies</p>
              <p class="metric-value">{{ status?.replies?.pending ?? '—' }}</p>
            </div>
          </div>
          <div class="pt-3 border-t" style="border-color: rgba(255,255,255,0.05);">
            <div
              v-if="status?.pipeline?.stages?.length"
              class="grid gap-2"
              :style="`grid-template-columns: repeat(${status.pipeline.stages.length}, 1fr)`"
            >
              <div v-for="stage in status.pipeline.stages" :key="stage.name" class="text-center">
                <p class="font-mono text-[17px] tabular-nums" style="color: rgba(245,242,236,0.85);">{{ stage.count }}</p>
                <p class="font-mono text-[8px] tracking-widest uppercase mt-1" style="color: rgba(245,242,236,0.25); line-height: 1.2;">{{ stage.name }}</p>
              </div>
            </div>
            <p v-else class="font-mono text-[9px] tracking-wider text-center" style="color: rgba(245,242,236,0.18);">
              pipeline · not connected
            </p>
          </div>
        </div>
      </section>

      <!-- ── Ops Library ── -->
      <section class="panel">
        <div class="panel-stripe" aria-hidden="true"></div>
        <div class="panel-head">
          <span class="panel-title">Ops Library</span>
        </div>
        <div class="panel-body flex flex-col items-center gap-2 py-4">
          <p class="font-mono text-[44px] tabular-nums leading-none" style="color: #B87333;">
            {{ status?.ops?.fileCount ?? 0 }}
          </p>
          <p class="metric-label">files synced</p>
          <p class="font-mono text-[10px] mt-1" style="color: rgba(245,242,236,0.25);">
            {{ status?.ops?.isEmpty
              ? 'run pnpm sync-ops to load'
              : 'synced ' + timeAgo(status?.ops?.syncedAt ?? '') }}
          </p>
          <p
            :class="['font-mono text-[9px] tracking-widest uppercase', status?.ops?.isEmpty ? 'ops-offline' : 'ops-online']"
          >
            {{ status?.ops?.isEmpty ? '○ context offline' : '● context active' }}
          </p>
        </div>
      </section>

    </div>

    <!-- Chevron tab — always visible at right edge, moves with drawer -->
    <button
      class="chevron-tab"
      :aria-label="modelValue ? 'Close agency panels' : 'Open agency panels'"
      @click="toggle"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        :class="['chevron-icon', modelValue ? '' : 'chevron-icon--flipped']"
        aria-hidden="true"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* ── Backdrop transition ── */
.fade-enter-active { transition: opacity 200ms ease; }
.fade-leave-active { transition: opacity 160ms ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ── Drawer header ── */
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  background: linear-gradient(180deg, rgba(255,255,255,0.02), transparent);
  flex-shrink: 0;
}

.drawer-eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(184,115,51,0.75);
}

.refresh-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: rgba(245,242,236,0.25);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 150ms;
  border-radius: 4px;
}
.refresh-btn:hover { color: #B87333; }

/* ── Panels scroll area ── */
.panels-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: rgba(184,115,51,0.15) transparent;
}
.panels-scroll::-webkit-scrollbar { width: 3px; }
.panels-scroll::-webkit-scrollbar-thumb { background: rgba(184,115,51,0.15); border-radius: 2px; }
.panels-scroll::-webkit-scrollbar-track { background: transparent; }

/* ── Panel card ── */
.panel {
  position: relative;
  background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px;
  overflow: hidden;
}

.panel-stripe {
  position: absolute;
  top: 0; left: 0;
  width: 28px; height: 1px;
  background: #B87333;
  box-shadow: 0 0 7px rgba(184,115,51,0.35);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  background: linear-gradient(180deg, rgba(255,255,255,0.015), transparent);
}

.panel-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: rgba(184,115,51,0.85);
}

.panel-body { padding: 14px; }

/* ── Metrics ── */
.metric-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: rgba(245,242,236,0.28);
  margin-bottom: 5px;
}

.metric-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
  color: rgba(245,242,236,0.88);
  font-variant-numeric: tabular-nums;
}

/* ── Ops status ── */
.ops-online { color: rgba(74,222,128,0.6); }
.ops-offline { color: rgba(245,242,236,0.18); }

/* ── Chevron tab ── */
.chevron-tab {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%) translateX(100%);
  width: 18px;
  height: 54px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b1525;
  border: 1px solid rgba(255,255,255,0.07);
  border-left: none;
  border-radius: 0 6px 6px 0;
  color: rgba(245,242,236,0.3);
  cursor: pointer;
  transition: color 150ms;
}
.chevron-tab:hover { color: #B87333; }

.chevron-icon {
  width: 9px;
  height: 9px;
  transition: transform 280ms ease;
  flex-shrink: 0;
}
.chevron-icon--flipped { transform: rotate(180deg); }

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .fade-leave-active { transition: none; }
  .chevron-icon { transition: none; }
}
</style>
