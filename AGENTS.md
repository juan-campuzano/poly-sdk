# AGENTS.md — poly-sdk (root)

## Build & Run Commands

```bash
# Install dependencies
pnpm install

# Build (TypeScript → dist/)
pnpm run build

# Watch mode (auto-rebuild on save)
pnpm run dev

# Run unit tests
pnpm run test

# Run tests in watch mode
pnpm run test:watch

# Run integration tests (requires PRIVATE_KEY)
PRIVATE_KEY=0x... pnpm run test:integration

# Run a specific example
PRIVATE_KEY=0x... pnpm run example:trading
```

## Testing

- **Test runner**: Vitest 2.x
- **Unit tests**: `src/__tests__/unit/`
- **Integration tests**: `src/__tests__/integration/`
- **WebSocket integration test** (required after any RealtimeServiceV2 change):
  ```bash
  PRIVATE_KEY=0x... npx tsx scripts/test-websocket-subscription.ts
  ```
- **CI logger gate** (required after adding new service instantiations):
  ```bash
  scripts/ci/check-logger-inject.sh diff
  ```

## Project Structure

```
src/
├── core/           # Shared primitives (errors, logger, rate-limiter, cache, types)
├── clients/        # HTTP adapters (data-api, gamma-api, subgraph, ctf-client, bridge-client)
├── services/       # Business logic services (trading, market, wallet, realtime, arb, ...)
├── realtime/       # WebSocket client (RealTimeDataClient)
├── smart-money/    # Copy trading module (core, copy, monitor, reports)
├── catalyst/       # Internal services (CatalystQueryService, etc.)
├── constants/      # Contract addresses (v2-contracts.ts = canonical SSOT), builder-config
├── utils/          # price-utils, calldata-decoder
└── index.ts        # Single public export surface
examples/           # 13 runnable examples (pnpm run example:*)
scripts/            # Local debugging scripts (never commit creds)
wiki/               # VitePress documentation site
docs/               # Markdown architecture docs
```

## Code Style

- **Language**: TypeScript 5.7, strict mode
- **Module format**: ESM only — all imports use `.js` extension even for `.ts` source files
- **Async**: always `async/await`, never `.then()` chains
- **Errors**: always throw `PolymarketError(message, ErrorCode.X)` — never raw `Error`
- **Logger**: always use `this.config.logger ?? log` (injected logger preferred over module default)
- **No implicit fallbacks**: data source selection must be explicit

## Git Workflow

- Branch: `copy-trading` is default
- Never commit: `.test-creds.json`, `scripts/test-*` outputs, private keys
- Before PR: run `pnpm run build && pnpm run test`

## Boundaries

### ✅ Always safe
- Adding methods to existing clients in `src/clients/`
- Adding new services to `src/services/` following existing patterns
- Adding unit tests

### ⚠️ Ask before
- Changing public exports in `src/index.ts` (breaking change risk)
- Modifying rate-limit values in `src/core/rate-limiter.ts`
- Changing contract addresses in `src/constants/v2-contracts.ts`

### 🚫 Never
- Change the default logger from console-backed to no-op
- Add `any` to public API types
- Commit private keys or credentials
- Add `require()` / CommonJS syntax (ESM-only)
- Use `0x3c499...` (native USDC) where USDC.e (`0x2791...`) is required
