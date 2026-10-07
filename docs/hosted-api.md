# Hosted service and installation notes

No hosted Ered Luin API or published SDK package is available from this repository today. The declarations in `packages/sdk/index.d.ts` can be used as a local type reference; they do not connect to a service.

When a hosted service is announced, its public documentation should specify the supported API version, authentication method, request and response schemas, rate limits, error behavior, and key-management guidance. Do not infer live endpoints or credentials from this example repository.

The offline demonstration has no install step beyond Node.js 20 or newer and runs with `npm run demo`.