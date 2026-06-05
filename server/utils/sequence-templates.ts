/**
 * The 4-email Polk Contractor sequence — relaxed voice.
 * Mirrored from ~/Personal/NordicNerd-Ops/03-Outbound-System/sequences/polk-contractor-sequence-v1.md
 * Edit here when iterating. The merge variables fill in from lead state.
 */

export interface SequenceStep {
  step: 1 | 2 | 3 | 4
  delay_days: number          // days after previous step
  subject: string
  body: string
}

export const POLK_RELAXED_V1: SequenceStep[] = [
  {
    step: 1,
    delay_days: 0,
    subject: `saw your {{city}} site`,
    body: `hey {{first_name}} — was just looking at {{company_name}}'s site.

a couple things on it I'd change that I think would meaningfully move what Google's sending you. nothing fancy — just the mechanical stuff most {{niche}} skip.

worth 15 min on a call? I'll walk you through exactly what I'd do, no pitch deck. if it's not a fit I'll say so on the call.

https://calendar.app.google/JheMSKoDMrWkiixy6

— Adam

The Nordic Nerd | thenordicnerd.com | {{physical_address}}
Reply STOP to opt out.`,
  },
  {
    step: 2,
    delay_days: 3,
    subject: `Re: saw your {{city}} site`,
    body: `{{first_name}} — quick bump.

to be specific about the "few things" — the biggest lever I see on most contractor GBPs is the Q&A section. almost nobody fills it out. but Google weights Q&A density heavily for local ranking, and the contractors winning {{city}} all have 10+ proactive Q&As on their listing. odds are yours is empty (or close to it).

fix is maybe 30 min of work. tends to show in rankings within 60 days.

happy to walk through the rest on a call. one more note from me later this week then I'll quit your inbox.

https://calendar.app.google/JheMSKoDMrWkiixy6

— Adam

The Nordic Nerd | thenordicnerd.com | {{physical_address}}
Reply STOP to opt out.`,
  },
  {
    step: 3,
    delay_days: 4,
    subject: `one more take on {{company_name}}`,
    body: `{{first_name}} — one more take then I'll get out of your inbox.

a lot of {{niche}} I see in {{city}} are paying for Google Ads to drive traffic that should be free. the reason: their GBP and site aren't doing the work, so they end up paying $20–$40 per click for searches they should rank on organically.

the math: one round of organic fixes = no longer paying for those clicks every month after. 60–90 days to start showing. compounds forever.

if your ads are working, ignore me. if you're not running ads but feel like leads come in slower than they should, worth a 15-min call?

https://calendar.app.google/JheMSKoDMrWkiixy6

— Adam

The Nordic Nerd | thenordicnerd.com | {{physical_address}}
Reply STOP to opt out.`,
  },
  {
    step: 4,
    delay_days: 7,
    subject: `ok, signing off`,
    body: `{{first_name}} — alright, last one.

if now's not the right time, no worries. bookmark in case future-you wants to revisit: https://calendar.app.google/JheMSKoDMrWkiixy6

one thing before I go: if you want the audit anyway with no call attached, reply "send the audit" and I'll write up the 5 things I'd change about how {{company_name}} shows up online as a one-pager. no catch, no follow-up unless you ask.

either way, good luck out there.

— Adam

The Nordic Nerd | thenordicnerd.com | {{physical_address}}
Reply STOP to opt out.`,
  },
]

/**
 * Replace {{merge_vars}} in template with actual values.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key as keyof typeof vars]
    return v !== undefined && v !== '' ? String(v) : `{{${key}}}`
  })
}
