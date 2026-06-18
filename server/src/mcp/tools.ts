import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db/index.js';
import { encrypt, maskKey } from '../lib/crypto.js';
import { resolveProvider, getAvailablePlatforms } from '../providers/index.js';

/** Register all MCP management tools on the given McpServer. */
export function registerMcpTools(server: McpServer) {
  // ── add_provider_key ────────────────────────────────────────────────────

  server.tool(
    'add_provider_key',
    "Add an API key for a free LLM provider platform.",
    {
      platform: z.enum(getAvailablePlatforms() as unknown as [string, ...string[]]),
      key: z.string().optional().describe('API key (required unless keyless)'),
      label: z.string().optional().describe('Optional label'),
    },
    async ({ platform, key, label }) => {
      const platforms = getAvailablePlatforms();
      if (!(platforms as string[]).includes(platform)) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unknown platform "${platform}". Available: ${platforms.join(', ')}` }],
        };
      }
      const provider = resolveProvider(platform as any);
      const isKeyless = provider?.keyless === true;
      const rawKey = key?.trim() ?? '';

      if (!isKeyless && !rawKey) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Platform "${platform}" requires an API key.` }],
        };
      }

      const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;
      const db = getDb();

      if (isKeyless) {
        const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
        if (existing) {
          db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              id: existing.id, platform, label: label ?? '',
              maskedKey: maskKey(keyToStore), status: 'unknown', enabled: true,
            }, null, 2) }],
          };
        }
      }

      const { encrypted, iv, authTag } = encrypt(keyToStore);
      const result = db.prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES (?, ?, ?, ?, ?, 'unknown', 1)`,
      ).run(platform, label ?? '', encrypted, iv, authTag);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          id: result.lastInsertRowid, platform, label: label ?? '',
          maskedKey: maskKey(keyToStore), status: 'unknown', enabled: true,
        }, null, 2) }],
      };
    },
  );

  // ── add_custom_model ────────────────────────────────────────────────────

  server.tool(
    'add_custom_model',
    "Register a custom OpenAI-compatible model endpoint.",
    {
      baseUrl: z.string().describe('Base URL, e.g. http://localhost:11434/v1'),
      model: z.string().describe('Model ID, e.g. qwen3:4b'),
      apiKey: z.string().optional().describe('Optional API key (defaults to no-key)'),
      label: z.string().optional().describe('Optional label'),
      displayName: z.string().optional().describe('Optional display name'),
    },
    async ({ baseUrl, model, apiKey, label, displayName }) => {
      if (!model?.trim()) {
        return { isError: true, content: [{ type: 'text' as const, text: 'model is required and must be non-empty' }] };
      }
      try { new URL(baseUrl); } catch {
        return { isError: true, content: [{ type: 'text' as const, text: `baseUrl must be a valid URL, got: "${baseUrl}"` }] };
      }

      const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
      const rawKey = apiKey?.trim() || 'no-key';
      const lbl = label ?? 'Custom';
      const modelId = model.trim();
      const dispName = displayName?.trim() || modelId;
      const db = getDb();

      const { encrypted, iv, authTag } = encrypt(rawKey);
      const r = db.prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
         VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)`,
      ).run(lbl, encrypted, iv, authTag, normalizedBaseUrl);
      const keyId = Number(r.lastInsertRowid);

      const scopedModelId = `${keyId}-${modelId}`;
      db.prepare(
        `INSERT INTO models
           (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
            rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, key_id, source)
         VALUES ('custom', ?, ?, 50, 50, 'Custom', NULL, NULL, NULL, NULL, '', NULL, 1, ?, 'user')
         ON CONFLICT(platform, model_id)
         DO UPDATE SET display_name = excluded.display_name, key_id = excluded.key_id, enabled = 1, source = 'user'`,
      ).run(scopedModelId, dispName, keyId);

      const modelRow = db.prepare(
        "SELECT id FROM models WHERE platform = 'custom' AND model_id = ?",
      ).get(scopedModelId) as { id: number };

      const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
      if (!inChain) {
        const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
        db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelRow.id, max.m + 1);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          keyId,
          modelDbId: modelRow.id,
          platform: 'custom',
          baseUrl: normalizedBaseUrl,
          models: [scopedModelId],
          displayName: dispName,
          maskedKey: maskKey(rawKey),
        }, null, 2) }],
      };
    },
  );
}
