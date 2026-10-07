# Ered Luin

Ered Luin is a research and policy demo that organizes market observations into auditable evidence packets and shows how an advisory workflow can support human review.

This public repository contains documentation, generic packet types, an offline demonstration, synthetic sample data, and small integration examples. It does not contain the production intelligence engine, private policy implementation, orchestration, operational configuration, or transaction and wallet systems.

## What is here

- A high-level [architecture overview](docs/architecture-overview.md) and [Buildathon description](docs/buildathon.md).
- Type-only [EvidencePacket and IntelligencePacket interfaces](packages/sdk/index.d.ts).
- A local demonstration using clearly synthetic data: `npm run demo`.
- A basic [Nansen request adapter](examples/nansen-adapter.mjs) and a deliberately limited [non-production policy example](examples/non-production-policy.mjs).
- A short note on [future hosted-service documentation](docs/hosted-api.md).

## Offline demonstration

Use Node.js 20 or newer. The offline demo uses no API credentials, network requests, wallet, or transaction code.

```sh
npm run demo
```

Every value in the demo fixture is synthetic and is not market evidence.

## Nansen example

The adapter is not called by the offline demo. A caller must explicitly invoke it and provide its own API key through `NANSEN_API_KEY`. A request to Nansen may consume the caller's credits. This repository's maintainers did not run the adapter as part of this migration. Check Nansen's current [authentication documentation](https://docs.nansen.ai/getting-started/authentication) before use.

## Boundaries

The examples are educational and non-production. They do not authorize or submit transactions, provide investment advice, or establish production readiness. Do not put credentials, private source data, or wallet secrets in this repository.