import { getOutboundDeliveryOverview } from '~/server/utils/outbound-delivery'

export default defineEventHandler(async () => await getOutboundDeliveryOverview())
