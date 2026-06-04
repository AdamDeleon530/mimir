<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

interface DashboardData {
  pipeline: {
    stages: Array<{ name: string; count: number; value: number }>
    stale: Array<{ name: string; days: number }>
  }
  money: { mtd: number; mrr: number; target: number; monthsToTarget: number | null }
  replies: { pending: number; recent: Array<{ from: string; subject: string }> }
  outbound: { bounceRate: number; complaintRate: number; inboxes: Array<{ name: string; health: 'green' | 'yellow' | 'red' }> }
  calls: Array<{ name: string; time: string; company: string }>
  clients: Array<{ name: string; tier: string; health: 'green' | 'yellow' | 'red' }>
}

const { data, refresh, pending } = await useAsyncData<DashboardData>('dashboard', () =>
  $fetch('/api/dashboard'),
)

function dollars(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
</script>

<template>
  <div class="min-h-screen px-6 py-8 max-w-6xl mx-auto">
    <!-- Header -->
    <header class="flex items-center justify-between mb-10">
      <div class="flex items-center gap-3">
        <img src="/favicon.svg" alt="" class="w-8 h-8" />
        <div>
          <h1 class="font-serif text-2xl">The Nordic Nerd</h1>
          <p class="text-xs text-offwhite/40">{{ new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) }}</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button @click="refresh()" :disabled="pending" class="px-3 py-1.5 text-xs text-offwhite/60 hover:text-offwhite border border-white/10 rounded transition-colors">
          {{ pending ? 'refreshing...' : 'refresh' }}
        </button>
        <NuxtLink to="/chat" class="px-4 py-1.5 text-sm bg-gold/90 text-matte rounded font-medium hover:bg-gold transition-colors">
          ask mimir →
        </NuxtLink>
      </div>
    </header>

    <!-- Grid -->
    <div v-if="data" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      <!-- Money -->
      <DashboardCard title="money" :accent="data.money.mtd > 0 ? 'gold' : undefined">
        <div class="space-y-3">
          <div class="flex items-baseline gap-2">
            <span class="font-serif text-4xl text-gold">{{ dollars(data.money.mtd) }}</span>
            <span class="text-xs text-offwhite/40">MTD</span>
          </div>
          <div class="text-sm text-offwhite/70">MRR: <span class="text-offwhite">{{ dollars(data.money.mrr) }}</span></div>
          <div v-if="data.money.target" class="text-xs text-offwhite/40">
            target: {{ dollars(data.money.target) }} ·
            <span v-if="data.money.monthsToTarget">{{ data.money.monthsToTarget }} mo at current pace</span>
            <span v-else>no growth yet</span>
          </div>
        </div>
      </DashboardCard>

      <!-- Pipeline -->
      <DashboardCard title="pipeline" class="md:col-span-2">
        <div class="space-y-3">
          <div class="grid grid-cols-6 gap-2 text-center">
            <div v-for="stage in data.pipeline.stages" :key="stage.name" class="space-y-0.5">
              <div class="text-2xl font-serif">{{ stage.count }}</div>
              <div class="text-[10px] uppercase tracking-wider text-offwhite/40">{{ stage.name }}</div>
              <div class="text-[10px] text-gold/80">{{ stage.value ? dollars(stage.value) : '' }}</div>
            </div>
          </div>
          <div v-if="data.pipeline.stale.length" class="pt-3 border-t border-white/5">
            <div class="text-xs text-critred mb-1">stale &gt; 5 days</div>
            <div class="space-y-1">
              <div v-for="deal in data.pipeline.stale" :key="deal.name" class="text-xs flex justify-between">
                <span>{{ deal.name }}</span>
                <span class="text-offwhite/40">{{ deal.days }}d</span>
              </div>
            </div>
          </div>
        </div>
      </DashboardCard>

      <!-- Replies pending -->
      <DashboardCard title="replies pending">
        <div class="space-y-2">
          <div class="text-3xl font-serif">{{ data.replies.pending }}</div>
          <div v-if="data.replies.recent.length" class="space-y-1.5 pt-2 border-t border-white/5">
            <div v-for="r in data.replies.recent" :key="r.subject" class="text-xs">
              <div class="text-offwhite">{{ r.from }}</div>
              <div class="text-offwhite/40 truncate">{{ r.subject }}</div>
            </div>
          </div>
          <div v-else class="text-xs text-offwhite/40 pt-2 border-t border-white/5">queue clean</div>
        </div>
      </DashboardCard>

      <!-- Outbound health -->
      <DashboardCard title="outbound health">
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div class="text-xs text-offwhite/40">bounce 7d</div>
              <div :class="data.outbound.bounceRate > 3 ? 'text-critred' : 'text-offwhite'">{{ data.outbound.bounceRate.toFixed(1) }}%</div>
            </div>
            <div>
              <div class="text-xs text-offwhite/40">complaints 7d</div>
              <div :class="data.outbound.complaintRate > 0.1 ? 'text-critred' : 'text-offwhite'">{{ data.outbound.complaintRate.toFixed(2) }}%</div>
            </div>
          </div>
          <div class="space-y-1 pt-2 border-t border-white/5">
            <div v-for="ib in data.outbound.inboxes" :key="ib.name" class="text-xs flex justify-between items-center">
              <span class="truncate">{{ ib.name }}</span>
              <span :class="{
                'bg-critgreen': ib.health === 'green',
                'bg-yellow-500': ib.health === 'yellow',
                'bg-critred': ib.health === 'red',
              }" class="w-1.5 h-1.5 rounded-full"></span>
            </div>
          </div>
        </div>
      </DashboardCard>

      <!-- Today's calls -->
      <DashboardCard title="today's calls">
        <div v-if="data.calls.length" class="space-y-2">
          <div v-for="call in data.calls" :key="call.time" class="text-sm">
            <div class="text-gold">{{ call.time }}</div>
            <div class="text-offwhite">{{ call.name }}</div>
            <div class="text-xs text-offwhite/40">{{ call.company }}</div>
          </div>
        </div>
        <div v-else class="text-sm text-offwhite/40">nothing on the calendar</div>
      </DashboardCard>

      <!-- Clients -->
      <DashboardCard title="active clients">
        <div v-if="data.clients.length" class="space-y-2">
          <div v-for="c in data.clients" :key="c.name" class="text-sm flex items-center justify-between">
            <div>
              <div>{{ c.name }}</div>
              <div class="text-xs text-offwhite/40">{{ c.tier }}</div>
            </div>
            <span :class="{
              'bg-critgreen': c.health === 'green',
              'bg-yellow-500': c.health === 'yellow',
              'bg-critred': c.health === 'red',
            }" class="w-2 h-2 rounded-full"></span>
          </div>
        </div>
        <div v-else class="text-sm text-offwhite/40">no clients yet — month 1</div>
      </DashboardCard>
    </div>
  </div>
</template>
