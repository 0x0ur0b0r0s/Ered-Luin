import Fastify from 'fastify';
import { runtimeConfigSchema } from '@ered-luin/contracts';
const config = runtimeConfigSchema.parse({
  NANSEN_API_ENABLED: process.env.NANSEN_API_ENABLED,
  NANSEN_CREDIT_BUDGET: process.env.NANSEN_CREDIT_BUDGET,
  LIVE_EXECUTION_ENABLED: process.env.LIVE_EXECUTION_ENABLED,
  EXECUTION_MODE: process.env.EXECUTION_MODE,
});
export const app = Fastify({ logger: true });
app.get('/healthz', async () => ({
  service: 'ered-luin-api', status: 'ok',
  paidNansenCallsEnabled: config.NANSEN_API_ENABLED === 'true',
  liveExecutionEnabled: config.LIVE_EXECUTION_ENABLED === 'true',
}));
if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: '0.0.0.0', port });
}
