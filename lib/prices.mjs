/**
 * Anthropic list prices, USD per million tokens: [input, output, cache read].
 * Checked against the Claude pricing page, 2026-10.
 *
 * Cache writes are priced off input: 1.25× for the 5-minute TTL, 2× for the
 * 1-hour TTL (which Claude Code uses). Web searches cost $10 per 1,000.
 *
 * Only used when a session has no cost record from Claude Code itself (see
 * transcripts.mjs). A model that is not listed here is reported as unpriced,
 * never counted as zero — add it from the pricing page.
 */
export const PRICES = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-mythos-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-mythos-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  // Haiku 5.5 doubles past 100K-token prompts; not modelled (Claude Code's own figure is).
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
};

export const WEB_SEARCH_USD = 0.01;

/** The price row for a model id; a dated snapshot (`claude-haiku-4-5-20251001`) uses its base row. */
export function priceOf(model) {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  const m = /^(.*)-\d{8}$/.exec(model);
  return (m && PRICES[m[1]]) || null;
}

/** USD for one API call's `usage` block, or null when the model is not priced. */
export function usageCost(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  const [inp, out, read] = p;
  const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cw5m = u.cache_creation?.ephemeral_5m_input_tokens ??
    Math.max((u.cache_creation_input_tokens ?? 0) - cw1h, 0);
  return ((u.input_tokens ?? 0) * inp + (u.output_tokens ?? 0) * out +
    (u.cache_read_input_tokens ?? 0) * read + cw1h * inp * 2 + cw5m * inp * 1.25) / 1e6 +
    (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

/** All billed tokens in a `usage` block (cache reads are most of them, but few of the dollars). */
export function usageTokens(u) {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
}
