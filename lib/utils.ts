import type { ClassValue } from "clsx"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Guards `href` bindings against `javascript:`/`data:`-style schemes that could
// sneak in through crawler-sourced auction links (detailUrl/pdfUrl/proxyUrl are
// upstream values, not always app-generated). Permits absolute http(s) URLs and
// app-relative paths; anything else collapses to undefined so the anchor renders
// inert instead of executable.
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return /^(https?:\/\/|\/)/i.test(url) ? url : undefined
}
