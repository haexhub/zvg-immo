import type { Component } from 'vue'
import { Flame, Mountain, ShieldAlert, Waves } from 'lucide-vue-next'

/** Icon, labels and the detail line for one hazard assessment, shared out of
 *  the detail page so its section file stays inside the size gate. */
export function useHazardDisplay() {
  const { t } = useI18n()
  const intlLocale = useIntlLocale()

  function hazardIcon(hazard: string): Component {
    if (hazard === 'flood') return Waves
    if (hazard === 'wildfire') return Flame
    if (hazard === 'avalanche') return Mountain
    return ShieldAlert
  }

  function hazardLabel(hazard: string): string {
    return t(`objektDetail.hazard.${hazard}`)
  }

  function hazardStatusLabel(status: string): string {
    return t(`objektDetail.hazardStatus.${status}`)
  }

  function hazardSeverityLabel(severity: string): string {
    return t(`objektDetail.hazardSeverity.${severity}`)
  }

  /** Headline for the map overlay/legend, e.g. "Hochwasser: in der Zone". */
  function hazardOverlayLabel(hazard: { hazard: string; status: string }): string {
    return `${hazardLabel(hazard.hazard)}: ${hazardStatusLabel(hazard.status)}`
  }

  function hazardStatusClass(status: string): string {
    if (status === 'inside') return 'text-destructive'
    if (status === 'nearby') return 'text-amber-700'
    if (status === 'outside') return 'text-emerald-700'
    return 'text-muted-foreground'
  }

  /**
   * Severity and distance, whichever of them the source actually carries.
   *
   * The EU Floods Directive layer behind the flood hazard has no severity
   * attribute at all — hazardCategory is "flood" and specificHazardType
   * "areaOfPotentialSignificantFloodRisk" for every zone in it (verified
   * against the live layer 2026-08-11). Printing "severity: unknown" on every
   * flood hazard read as a missing value rather than as "this source doesn't
   * grade risk"; its status plus the distance is the whole statement it makes.
   */
  function hazardDetailLine(hazard: { severity: string; distanceMeters: number | null }): string {
    const parts: string[] = []
    if (hazard.severity !== 'unknown') {
      parts.push(`${t('objektDetail.hazardSeverityLabel')} ${hazardSeverityLabel(hazard.severity)}`)
    }
    if (hazard.distanceMeters != null) {
      parts.push(t('objektDetail.hazardDistance', {
        meters: hazard.distanceMeters.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 }),
      }))
    }
    return parts.join(' · ')
  }

  return {
    hazardDetailLine,
    hazardIcon,
    hazardLabel,
    hazardOverlayLabel,
    hazardStatusClass,
    hazardStatusLabel,
  }
}
