/**
 * GET /api/markets
 *
 * Returns the 56-cell coverage matrix merged with lead-DB aggregates per cell.
 * Powers the /markets dashboard.
 */
import { getCoverageMatrix, NICHES, POLK_CITIES } from '~/server/utils/coverage-matrix'
import { listLeads } from '~/server/utils/lead-db'

interface CellAggregates {
  city: string
  niche_slug: string
  leads_in_db: number
  contacted_in_db: number
  replied_positive: number
  avg_quality: number
  top_quality: number
}

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  const { cells, totals } = await getCoverageMatrix()

  // For each cell, pull DB leads matching this city + niche keyword.
  // listLeads filter is substring-based; the niche slug usually appears in the
  // category field (e.g. "Roofing contractor" matches "roofer" weakly — use
  // the .query of the niche spec for a clean substring like "roofer").
  const aggregates: Record<string, CellAggregates> = {}
  for (const niche of NICHES) {
    for (const city of POLK_CITIES) {
      const { leads } = await listLeads({ city, niche: niche.query, limit: 200 })
      const qualities = leads.map(l => l.quality_total ?? 0)
      const avg = qualities.length ? Math.round(qualities.reduce((a, b) => a + b, 0) / qualities.length) : 0
      const top = qualities.length ? Math.max(...qualities) : 0
      aggregates[`${city}|${niche.slug}`] = {
        city,
        niche_slug: niche.slug,
        leads_in_db: leads.length,
        contacted_in_db: leads.filter(l => l.status === 'contacted' || l.status === 'replied_positive' || l.status === 'replied_question' || l.status === 'replied_objection').length,
        replied_positive: leads.filter(l => l.status === 'replied_positive').length,
        avg_quality: avg,
        top_quality: top,
      }
    }
  }

  // Merge: cell state + aggregates → one shape per grid square
  const merged = cells.map(cell => {
    const agg = aggregates[`${cell.city}|${cell.niche_slug}`] ?? {
      city: cell.city, niche_slug: cell.niche_slug,
      leads_in_db: 0, contacted_in_db: 0, replied_positive: 0,
      avg_quality: 0, top_quality: 0,
    }
    return { ...cell, ...agg }
  })

  return {
    cells: merged,
    totals,
    grid: {
      cities: [...POLK_CITIES],
      niches: NICHES.map(n => ({ slug: n.slug, label: n.query })),
    },
  }
})
