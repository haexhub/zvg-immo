import { apiErrorStatusCode } from '~/lib/api-error'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchWithPendingRetry<T>(
  fetcher: () => Promise<T>,
  options: {
    maxPolls: number
    retryMs: number
    shouldContinue?: () => boolean
  },
): Promise<T | null> {
  for (let attempt = 0; attempt <= options.maxPolls; attempt++) {
    if (options.shouldContinue && !options.shouldContinue()) return null
    try {
      return await fetcher()
    } catch (err) {
      if (apiErrorStatusCode(err) !== 409 || attempt === options.maxPolls) throw err
      if (options.shouldContinue && !options.shouldContinue()) return null
      await sleep(options.retryMs)
    }
  }
  return null
}
