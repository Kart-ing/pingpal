/**
 * Project-level PingPal for OpenCode.
 *
 * Re-exports the global plugin from ~/.config/opencode/plugins/pingpal.ts.
 *
 * OpenCode auto-loads plugins from both:
 *   1. ~/.config/opencode/plugins/   (global)
 *   2. .opencode/plugins/            (project)
 *
 * This file exists so the project explicitly declares its pingpal dependency,
 * but the actual implementation lives globally so it's always up to date.
 */
export { PingPalPlugin } from "/Users/kartikeypandey/.config/opencode/plugins/pingpal.ts";
