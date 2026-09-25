import { http, type HttpTransportConfig, type Transport } from 'viem'

/**
 * Robinhood Chain's public RPC (`rpc.mainnet.chain.robinhood.com`, baked into
 * viem's official `robinhood`/`robinhoodTestnet` chain defs and used as the
 * zero-config default everywhere in this repo) sits behind Cloudflare, and
 * Cloudflare's managed bot-fight rules 403 any request whose `User-Agent`
 * looks like a bare HTTP client — which is exactly what Node's built-in
 * `fetch` (undici) sends by default. Verified directly: an identical POST
 * with `curl`'s default UA gets 200; the same request via Node `fetch` with
 * no UA override gets a Cloudflare "Just a moment…" challenge page (403).
 * Setting ANY honest, self-identifying `User-Agent` — not a spoofed browser
 * string — is sufficient; also verified directly.
 *
 * Without this, every RPC call over the zero-config default endpoint fails
 * silently: `Market`'s methods all catch-and-return-null on error, so a
 * fully broken connection looks identical to "no liquidity" rather than
 * raising anything a strategy or operator would notice.
 */
const USER_AGENT = 'hood-traders/0.2.0 (+https://github.com/nirholas/robinhood-chain-trading-bot)'

/** `viem.http()` with the User-Agent fix applied. Use this anywhere the chain's public RPC might be hit. */
export function httpTransport(rpcUrl?: string, config: HttpTransportConfig = {}): Transport {
  return http(rpcUrl, {
    ...config,
    fetchOptions: {
      ...config.fetchOptions,
      headers: { 'User-Agent': USER_AGENT, ...config.fetchOptions?.headers },
    },
  })
}
