import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';

export const modelsRouter = Router();

// Fields a maintainer can change via PATCH /api/models/:id. Anything else in
// the body is rejected (the response lists the offenders) so identity-bearing
// fields (platform, modelId, source) and routing-policy fields (ranks, limits,
// monthly_token_budget) cannot drift away from their write-path defaults.
const PATCH_ALLOWED_FIELDS = ['displayName', 'enabled', 'contextWindow', 'supportsVision', 'supportsTools'] as const;

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    supportsVision: m.supports_vision === 1,
    supportsTools: m.supports_tools === 1,
    source: m.source,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});

// Add a user-managed model. Mirrors the custom-provider flow (#212): one
// INSERT into models + one INSERT into fallback_config in a single transaction
// so the router never sees a half-registered model. The source='user' tag is
// what protects this row from catalog-sync's delete pass and from /api/models
// DELETE on catalog/migration rows.
modelsRouter.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const platform = typeof body.platform === 'string' ? body.platform : '';
  const modelId = typeof body.modelId === 'string' ? body.modelId : '';

  if (!platform || !modelId) {
    return res.status(400).json({ error: 'platform and modelId are required' });
  }
  if (platform === 'custom') {
    return res.status(400).json({ error: 'Use POST /api/keys/custom for custom providers' });
  }
  if (!hasProvider(platform as any)) {
    return res.status(400).json({ error: `Unknown platform: ${platform}` });
  }
  if (modelId.length > 200) {
    return res.status(400).json({ error: 'modelId must be ≤ 200 characters' });
  }

  const displayName = typeof body.displayName === 'string' && body.displayName.length > 0 ? body.displayName : modelId;
  const contextWindow = typeof body.contextWindow === 'number' ? body.contextWindow : null;
  const supportsVision = body.supportsVision === true ? 1 : 0;
  const supportsTools = body.supportsTools === true ? 1 : 0;

  const db = getDb();
  // Pre-check the UNIQUE before opening the transaction so we can return 409
  // without relying on the constraint exception (better-sqlite3 surfaces it as
  // SqliteError, but the structured 409 reply is clearer for the client).
  const existing = db
    .prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number } | undefined;
  if (existing) {
    return res.status(409).json({ error: 'Model already exists', existingId: existing.id });
  }

  let newId = 0;
  const insert = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                             monthly_token_budget, context_window, enabled, supports_vision, supports_tools, source)
         VALUES (?, ?, ?, 50, 50, 'User', '', ?, 1, ?, ?, 'user')`,
      )
      .run(platform, modelId, displayName, contextWindow, supportsVision, supportsTools);
    newId = Number(info.lastInsertRowid);
    const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(newId, max.m + 1);
  });
  insert();

  res.status(201).json({
    success: true,
    id: newId,
    platform,
    modelId,
    displayName,
    contextWindow,
    supportsVision: supportsVision === 1,
    supportsTools: supportsTools === 1,
    enabled: true,
    source: 'user',
  });
});

// Edit a model row. Allowed fields are PATCH_ALLOWED_FIELDS — anything else
// (platform, modelId, source, ranks, limits, monthly_token_budget) is rejected
// with the offender list so the client can surface the violation precisely.
modelsRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowed = new Set<string>(PATCH_ALLOWED_FIELDS);
  const offending = Object.keys(body).filter(k => !allowed.has(k));
  if (offending.length > 0) {
    return res.status(400).json({ error: 'Cannot PATCH these fields', fields: offending });
  }

  const db = getDb();
  const row = db.prepare('SELECT id FROM models WHERE id = ?').get(id) as { id: number } | undefined;
  if (!row) return res.status(404).json({ error: 'model not found' });

  const sets: string[] = [];
  const params: any[] = [];
  if (typeof body.displayName === 'string') {
    sets.push('display_name = ?');
    params.push(body.displayName);
  }
  if (typeof body.enabled === 'boolean') {
    sets.push('enabled = ?');
    params.push(body.enabled ? 1 : 0);
  }
  if (body.contextWindow === null || typeof body.contextWindow === 'number') {
    sets.push('context_window = ?');
    params.push(body.contextWindow);
  }
  if (typeof body.supportsVision === 'boolean') {
    sets.push('supports_vision = ?');
    params.push(body.supportsVision ? 1 : 0);
  }
  if (typeof body.supportsTools === 'boolean') {
    sets.push('supports_tools = ?');
    params.push(body.supportsTools ? 1 : 0);
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: 'no editable fields provided' });
  }

  params.push(id);
  db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as any;
  res.json({
    id: updated.id,
    platform: updated.platform,
    modelId: updated.model_id,
    displayName: updated.display_name,
    contextWindow: updated.context_window,
    enabled: updated.enabled === 1,
    supportsVision: updated.supports_vision === 1,
    supportsTools: updated.supports_tools === 1,
    source: updated.source,
  });
});

// Hard-delete a model. Only source='user' rows are eligible — catalog/migration
// rows would just reappear on the next sync/boot, so DELETE returns 400 with a
// hint to use PATCH {enabled: false} instead.
modelsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const db = getDb();
  const row = db.prepare('SELECT id, source FROM models WHERE id = ?').get(id) as { id: number; source: string } | undefined;
  if (!row) return res.status(404).json({ error: 'model not found' });
  if (row.source !== 'user') {
    return res.status(400).json({
      error: `Cannot hard-delete ${row.source} models. Use PATCH {enabled:false} instead.`,
    });
  }
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare('DELETE FROM models WHERE id = ?').run(id);
  });
  remove();
  res.json({ success: true });
});
