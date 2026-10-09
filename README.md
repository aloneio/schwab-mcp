# Schwab MCP Server

A Model Context Protocol (MCP) server that enables AI assistants like Claude to
securely access Charles Schwab account and market data through the official
Schwab API. This server is intentionally read-only and does not expose order
placement, replacement, or cancellation capabilities.

## What You Can Do

Ask Claude to:

- "Show me my Schwab account balances and positions"
- "Get real-time quotes for AAPL, GOOGL, and MSFT"
- "What are today's market movers in the $SPX?"
- "Show me the options chain for TSLA with Greeks"
- "Get my transactions from the last 30 days"
- "Search for ETFs related to technology"
- "Check if the markets are open"

## Unofficial MCP Server

This is an unofficial, community-developed TypeScript MCP server for Charles
Schwab. It has not been approved, endorsed, or certified by Charles Schwab. It
is provided as-is, and its functionality may be incomplete or unstable. Use at
your own risk when handling financial data. The MCP surface is intentionally
read-only and cannot place, replace, or cancel orders.

## Overview

This MCP server acts as a bridge between AI assistants and the Schwab API,
providing:

- **OAuth Authentication**: Browser-bound, expiring authorization transactions
  with PKCE and explicit client consent
- **Read-Only Brokerage Data**: Access to accounts, order history, quotes, and
  transactions without order execution
- **Market Data Tools**: Real-time quotes, price history, market hours, movers,
  and options chains
- **Account Privacy**: Built-in account identifier scrubbing to protect
  sensitive information
- **Cloudflare Workers**: Durable Objects coordinate sessions and credential
  storage

## Features

### Account & Brokerage Data Tools

- **Account Management**
  - `getAccounts`: Retrieve all account information with positions and balances
  - `getAccount`: Retrieve one account, optionally including positions
  - `getAccountNumbers`: Get list of account identifiers
- **Order History (Read-Only)**
  - `getOrder`: Get order by ID
  - `getOrders`: Fetch orders with filtering by status and time range
  - `getOrdersByAccountNumber`: Get orders by account number
- **Market Quotes**
  - `getQuotes`: Get real-time quotes for multiple symbols
  - `getQuoteBySymbolId`: Get detailed quote for a single symbol
- **Transaction History**
  - `getTransactions`: Retrieve transaction history across all accounts with
    date filtering
  - `getTransaction`: Retrieve one transaction for an account
- **User Preferences**
  - `getUserPreference`: Retrieve user trading preferences and settings

> [!IMPORTANT] This MCP server intentionally exposes no order-write tools. It
> cannot place, replace, or cancel Schwab orders. Order endpoints in this
> project are limited to read-only retrieval.

The brokerage and market-data transport permits only `GET` requests to an
explicit allowlist of Schwab read endpoints. Unsupported URLs, other methods,
and redirects are rejected before a business request is sent. OAuth token
exchange and refresh use a separate, fixed token endpoint and require `POST`;
those authentication requests do not execute trades. The GET restriction does
not reduce the permissions granted to the underlying Schwab application, so
protect its credentials and use the intended app configuration.

### Market Data Tools

- **Instrument Search**
  - `searchInstruments`: Search for securities by symbol with
    fundamental/reference data
  - `getInstrumentByCusip`: Retrieve instrument information by CUSIP
- **Price History**
  - `getPriceHistory`: Get historical price data with customizable periods and
    frequencies
- **Market Hours**
  - `getMarketHours`: Check market operating hours by date
  - `getMarketHoursByMarketId`: Get specific market information
- **Market Movers**
  - `getMovers`: Find top market movers by index ($SPX, $COMPX, $DJI)
- **Options Chains**
  - `getOptionChain`: Retrieve full options chain data with Greeks
  - `getOptionExpirationChain`: Get option expiration dates

## Prerequisites

1. **Schwab Developer Account**: Register at
   [Schwab Developer Portal](https://developer.schwab.com)
2. **Cloudflare Account**: Workers, Workers KV, and SQLite Durable Objects
3. **Node.js**: Version 22.x
4. **Wrangler CLI**: Installed via npm (included in dev dependencies)

## Getting Started

### Quick Setup

```bash
git clone https://github.com/aloneio/schwab-mcp.git
cd schwab-mcp
npm ci

# Authenticate with Cloudflare (first time only)
npx wrangler login

# Create KV namespace for MCP OAuth client registrations and grants
npx wrangler kv namespace create "OAUTH_KV"
# Note the ID from the output - you'll need it for configuration

# Set up your personal configuration
cp wrangler.example.jsonc wrangler.jsonc
# Edit wrangler.jsonc to:
# 1. Replace YOUR_KV_NAMESPACE_ID_HERE with the ID from above
# 2. Change the name to something unique (e.g., "schwab-mcp-yourname")

# Set your secrets
npx wrangler secret put SCHWAB_CLIENT_ID      # Your Schwab App Key
npx wrangler secret put SCHWAB_CLIENT_SECRET  # Your Schwab App Secret
npx wrangler secret put SCHWAB_REDIRECT_URI   # https://your-worker-name.your-subdomain.workers.dev/callback
npx wrangler secret put COOKIE_ENCRYPTION_KEY # Generate with: openssl rand -hex 32

# Deploy
npm run deploy
```

### Configuration Notes

- `wrangler.example.jsonc` - Template configuration (committed)
- `wrangler.jsonc` - Your personal config (git-ignored, created from template)
- `.dev.vars` - Local development secrets (git-ignored, optional)

Since `wrangler.jsonc` is git-ignored, you can safely develop and test with your
personal configuration without exposing secrets.

`COOKIE_ENCRYPTION_KEY` is a retained configuration name for the random cookie
**signing** secret; it does not imply encrypted cookies. Generate a fresh secret
with `openssl rand -hex 32`. Configuration rejects values shorter than 32 UTF-8
bytes. Never commit `.dev.vars` or share the generated secret.

For an existing deployment, retain migration `v1` and add the template's `v2`
migration plus the `SCHWAB_AUTH` binding for `SchwabAuthCoordinator`. Users must
authorize again after this update: legacy Schwab credentials in KV are no longer
read or migrated. `OAUTH_KV` remains required for MCP OAuth clients and grants.

Use the exact origin of `SCHWAB_REDIRECT_URI` when connecting to `/sse`. The
callback must use HTTPS and the `/callback` path, without a query or fragment.
Requests using an alternate hostname receive HTTP 421 so authorization cannot
start on a hostname that will not receive the browser cookie at callback time.

### Detailed Configuration

#### 1. Create a Schwab App

1. Log in to the [Schwab Developer Portal](https://developer.schwab.com)
2. Create a new app with:
   - **App Name**: Your MCP server name
   - **Callback URL**:
     `https://schwab-mcp.<your-subdomain>.workers.dev/callback`
   - **App Type**: Personal or third-party based on your use case
3. Note your **App Key** (Client ID) and generate an **App Secret**

#### 2. Set Environment Variables

The same secrets from Quick Setup need to be set (see above).

### GitHub Actions Deployment

For automated deployments, add these GitHub repository secrets:

1. **`CLOUDFLARE_API_TOKEN`**: Your Cloudflare API token
2. **`OAUTH_KV_ID`**: Your KV namespace ID

The workflow handles validation and deployment when pushing to `main`. It
installs the lockfile with `npm ci` and runs validation and tests before
deployment. Pull requests run these checks without deploying.

Set the repository variable **`CLOUDFLARE_WORKER_NAME`** to the same Worker name
as your personal configuration (default for CI: `schwab-mcp`). Set Cloudflare
secrets on that exact Worker with
`npx wrangler secret put <NAME> --name <WORKER>`; secrets attached to a
different personal Worker are not copied by CI.

### Testing with Inspector

Test your deployment using the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

Enter `https://schwab-mcp.<your-subdomain>.workers.dev/sse` and connect. You'll
be prompted to authenticate with Schwab.

## Usage

### Claude Desktop Configuration

### 1. Use Claude Integrations

1. Go to the [Claude Desktop](https://www.anthropic.com/docs/claude-desktop)
   settings
2. Click on the "Integrations" tab
3. Click on the "Add Custom Integration" button
4. Enter the integration name "Schwab"
5. Enter the MCP Server URL:
   `https://schwab-mcp.<your-subdomain>.workers.dev/sse`
6. Click on the "Add" button
7. Click "Connect" and the Schwab Authentication flow will start.

### 2. Add the MCP Server to your Claude Desktop configuration

Add the following to your Claude Desktop configuration file:

```json
{
	"mcpServers": {
		"schwab": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"https://schwab-mcp.<your-subdomain>.workers.dev/sse"
			]
		}
	}
}
```

Restart Claude Desktop. When you first use a Schwab tool, a browser window will
open for authentication.

### Example Commands

Once connected, you can ask Claude to:

- "Show me my Schwab account balances"
- "Get a quote for AAPL"
- "What are today's market movers in the $SPX?"
- "Show me the options chain for TSLA"
- "Get my recent transactions from the last week"

### Local Development

For local development, create a `.dev.vars` file (automatically ignored by git):

```env
SCHWAB_CLIENT_ID=your_development_app_key
SCHWAB_CLIENT_SECRET=your_development_app_secret
SCHWAB_REDIRECT_URI=https://localhost:8788/callback
COOKIE_ENCRYPTION_KEY=replace_with_your_generated_random_secret
LOG_LEVEL=debug
ENVIRONMENT=development
```

Run locally:

```bash
npm run dev
# Server will be available at https://localhost:8788
```

Replace the secret placeholder with the output of `openssl rand -hex 32`.
Connect to `https://localhost:8788/sse` using the MCP Inspector. Configure the
exact HTTPS callback URL in your Schwab developer app and trust the local
development certificate in the browser/client. Local testing uses local KV and
Durable Object storage; real OAuth and market/account calls still contact
Schwab.

## Architecture

### Technology Stack

- **Runtime**: Cloudflare Workers with Durable Objects
- **Authentication**: OAuth 2.0 with PKCE via
  `@cloudflare/workers-oauth-provider`
- **API Client**: Local read-only HTTP adapter, with endpoint metadata and input
  types from `@sudowealth/schwab-api`
- **MCP Framework**: `@modelcontextprotocol/sdk` with Durable Object SSE
  transport
- **State Management**: KV for MCP OAuth registrations/grants; Durable Objects
  for one-use authorization transactions, per-user Schwab tokens, and sessions

### Security Features

1. **Authorization transactions**: Original OAuth request and PKCE verifier stay
   in a Durable Object. Transactions expire after 10 minutes and callbacks
   consume them once.
2. **Browser binding**: HMAC-SHA256 authenticates a random browser cookie with
   `Secure`, `HttpOnly`, `SameSite=Lax`, and a `__Host-` name. Explicit approval
   is required before continuing to Schwab.
3. **Credential isolation**: Per-user Durable Objects store Schwab tokens and
   serialize refresh operations. MCP sessions retain identity, not token copies.
4. **Read-only business transport**: A URL and method allowlist limits brokerage
   and market-data calls to supported `GET` endpoints.
5. **Account scrubbing**: Account display labels replace supported account
   identifier fields in tool results. Clients still receive the financial data
   they request; this is not anonymization of the entire response.
6. **Log redaction**: Structured secret and account fields are scrubbed
   recursively before logging, including arrays and nested errors. Avoid putting
   credentials or full response bodies in free-text log messages.

## Development

### Available Scripts

```bash
npm run dev          # Start development server on port 8788
npm run deploy       # Deploy to Cloudflare Workers
npm run typecheck    # Run TypeScript type checking
npm run lint         # Check ESLint rules
npm test             # Run local regression tests
npm run test:integration # Build and exercise the local Worker with a fixture upstream
npm run test:integration # Bundle and run mock OAuth/SSE in a real local Worker
npm run build        # Bundle with Wrangler without uploading
npm run format       # Format code with Prettier
npm run validate     # Run typecheck and lint together
```

### Debugging

The server includes comprehensive logging with configurable levels:

- **Development**: Structured terminal logs
- **Production**: Cloudflare dashboard → Workers → Logs
- **Log Levels**: trace, debug, info, warn, error, fatal (`LOG_LEVEL`,
  case-insensitive)

Enable debug logging to see detailed OAuth flow and API interactions:

```bash
# For local development
echo "LOG_LEVEL=debug" >> .dev.vars

# For production
npx wrangler secret put LOG_LEVEL
# Enter debug at the prompt (use --name if targeting a different Worker)
```

### Error Handling

Authentication routes return HTTP errors, while tool failures use MCP's
`isError` response. Error messages distinguish invalid input, authentication,
and upstream failures. Schwab request IDs are included when the upstream error
provides them; not every failure has a request ID.

### Verification Scope

`npm test` exercises local regression cases with synthetic data and mocked
upstream requests. `npm run validate` checks TypeScript and ESLint. A Wrangler
dry-run verifies that the Worker bundles. `npm run test:integration` also runs
the bundled Worker in Miniflare with real local KV and SQLite Durable Objects,
using an outbound fixture for every Schwab call. It checks OAuth discovery,
registration, consent, PKCE, token issuance, SSE initialization, tool discovery,
status, a quote request, and reauthorization after credential invalidation. CI
runs both test suites. None of these checks proves that real Schwab
authorization, token refresh, permissions, or live account/market responses
work. A credentialed end-to-end check is a separate step and must use the
intended account and deployment. Dependency audit counts describe installed
packages; assess the deployed bundle and feature usage before treating each
advisory as a reachable production issue.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT

## Troubleshooting

### Common Issues

1. **"KV namespace not found" error**

   - Ensure you created the KV namespace and updated `wrangler.jsonc`
   - Run `npx wrangler kv namespace list` to verify

2. **Authentication failures**

   - Verify your redirect URI matches exactly in Schwab app settings
   - Check that all secrets are set correctly with `npx wrangler secret list`
   - Enable debug logging to see detailed OAuth flow

3. **"Durable Objects not available" error**

   - Check that both `MCP_OBJECT` and `SCHWAB_AUTH` bindings are configured
   - Retain migration `v1` and add the template's `v2` migration

4. **Token refresh issues**
   - Reauthorize when Schwab rejects an expired or revoked refresh token
   - Confirm the `SCHWAB_AUTH` Durable Object binding and secrets are present
   - Existing KV credentials are not reused; reauthorize after upgrading

## Recent Updates

- **Token Management**: Per-user Durable Objects coordinate credential updates
- **OAuth Transactions**: Expiring, browser-bound, one-use authorization state
- **Read-Only Transport**: A GET-only endpoint allowlist for business API calls
- **Better Error Handling**: Structured error types with Schwab API error
  mapping
- **Configurable Logging**: Debug mode for troubleshooting OAuth and API issues

## Acknowledgments

- Built with [Cloudflare Workers](https://workers.cloudflare.com/)
- Uses [Model Context Protocol](https://modelcontextprotocol.io/)
- Powered by
  [@sudowealth/schwab-api](https://www.npmjs.com/package/@sudowealth/schwab-api)
