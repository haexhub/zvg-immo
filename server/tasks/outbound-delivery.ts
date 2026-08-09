// Retries the durable mail outbox. This is intentionally independent from the
// request that created the business record: a client timeout or SMTP outage
// must not produce another commission-bearing lawyer inquiry on retry.
import { drainOutboundDeliveries } from '../utils/outbound-delivery'
import { runExclusiveTask } from '../utils/exclusive-task'

export default defineTask({
  meta: {
    name: 'outbound-delivery',
    description: 'Deliver pending alert and lawyer inquiry emails from the durable outbox.',
  },
  async run() {
    return await runExclusiveTask('outbound-delivery', async () => ({
      result: await drainOutboundDeliveries(),
    }))
  },
})
