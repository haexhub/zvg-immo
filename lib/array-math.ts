// Math.min(...values)/Math.max(...values) spread the array as call
// arguments — fine for a handful of values, but real data-derived arrays
// (geometry vertices, PDF image clusters, description tokens, ...) can grow
// into the tens of thousands, which blows V8's argument-count limit
// ("Maximum call stack size exceeded"). These loop-based equivalents have no
// such limit; use them for any array whose size isn't a small hardcoded
// constant.

export function minOf(values: number[]): number {
  let min = Number.POSITIVE_INFINITY
  for (const value of values) {
    min = Math.min(min, value)
  }
  return min
}

export function maxOf(values: number[]): number {
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    max = Math.max(max, value)
  }
  return max
}
