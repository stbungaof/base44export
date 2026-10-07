import type { Finding, MigrationPlan, PlanStep } from '@b44/shared';
import type { MigrationContext } from './context';

const FRONTEND_CONVERTIBLE = new Set(['vite-react', 'vite-vue', 'vite-svelte', 'vite-vanilla', 'cra-react', 'static-html']);

/** Derive the migration plan strictly from what the analyzer found. */
export function buildPlan(ctx: MigrationContext): MigrationPlan {
  const a = ctx.analysis;
  const b = a.base44;
  const steps: PlanStep[] = [];
  const manual: Omit<Finding, 'id'>[] = [];
  const step = (s: PlanStep) => steps.push(s);

  const usesSdk = b.sdkImports.length > 0 || '@base44/sdk' in b.packages;
  const usedEntities = Object.keys(b.entityUsage).filter((k) => k !== '<dynamic>');
  const definedNames = new Set(b.entities.map((e) => e.name));

  step({ id: 'preserve', stage: 'TRANSFORM', title: 'Copy untouched source to project/original', automatic: true });

  // --- database ---
  if (b.entities.length > 0) {
    step({
      id: 'db-schema',
      stage: 'DATABASE',
      title: `Generate PostgreSQL schema for ${b.entities.length} entit${b.entities.length === 1 ? 'y' : 'ies'}`,
      automatic: true,
      details: b.entities.map((e) => e.name).join(', '),
    });
  } else {
    manual.push({
      severity: 'manual',
      category: 'database',
      message:
        'No entity schema files (entities/*.json) were found. No tables can be generated; define the data model manually.',
    });
  }
  for (const f of b.unparsedEntityFiles) {
    manual.push({ severity: 'manual', category: 'database', message: 'Entity file is not a valid object schema', file: f });
  }
  for (const n of usedEntities) {
    if (!definedNames.has(n)) {
      manual.push({
        severity: 'manual',
        category: 'database',
        message: `Code uses entity "${n}" but no schema for it was found in the export.`,
        file: b.entityUsage[n]?.[0]?.file,
        line: b.entityUsage[n]?.[0]?.line,
      });
    }
  }
  if (b.entityUsage['<dynamic>']) {
    manual.push({
      severity: 'warning',
      category: 'database',
      message: 'Dynamic entity access (base44.entities[...]) found; it will work only for entities that have generated tables.',
      file: b.entityUsage['<dynamic>'][0]?.file,
      line: b.entityUsage['<dynamic>'][0]?.line,
    });
  }
  step({
    id: 'db-data',
    stage: 'DATABASE',
    title: 'Existing Base44 record data',
    automatic: false,
    details: 'The ZIP export holds code only. Data must be exported from Base44 and imported manually.',
  });
  manual.push({
    severity: 'manual',
    category: 'database',
    message: 'Existing application data is not part of a code export; export it from Base44 and import it into PostgreSQL.',
  });

  // --- storage ---
  step({ id: 'storage', stage: 'STORAGE', title: 'Generate local-filesystem upload storage (/uploads)', automatic: true });
  if (b.remoteStorageRefs.length > 0) {
    manual.push({
      severity: 'manual',
      category: 'storage',
      message: `${b.remoteStorageRefs.length} hard-coded Base44-hosted URL(s) found. Files behind them must be downloaded and re-hosted manually.`,
      file: b.remoteStorageRefs[0]?.file,
      line: b.remoteStorageRefs[0]?.line,
      snippet: b.remoteStorageRefs[0]?.snippet,
    });
  }

  // --- source ---
  ctx.frontendConvertible = FRONTEND_CONVERTIBLE.has(a.framework);
  if (usesSdk) {
    step({
      id: 'sdk-shim',
      stage: 'TRANSFORM',
      title: 'Replace @base44/sdk imports with a local REST compatibility layer',
      automatic: true,
    });
  }
  for (const pkgName of Object.keys(b.packages)) {
    if (pkgName !== '@base44/sdk') {
      manual.push({
        severity: 'manual',
        category: 'dependencies',
        message: `Dependency ${pkgName} is Base44-specific and is NOT converted automatically (left in place).`,
      });
    }
  }
  for (const [name, hits] of Object.entries(b.authUsage)) {
    manual.push({
      severity: name === 'me' || name === 'isAuthenticated' || name === 'logout' ? 'warning' : 'manual',
      category: 'auth',
      message:
        name === 'me' || name === 'isAuthenticated' || name === 'logout'
          ? `base44.auth.${name}() is served by a single local user (no real login). Add authentication before exposing the app.`
          : `base44.auth.${name}() has no local equivalent; implement manually.`,
      file: hits[0]?.file,
      line: hits[0]?.line,
    });
  }
  for (const [name, hits] of Object.entries(b.integrationUsage)) {
    if (name === 'Core.UploadFile') continue;
    manual.push({
      severity: 'manual',
      category: 'integrations',
      message: `Base44 integration ${name} is not available self-hosted; calls will throw until you implement it.`,
      file: hits[0]?.file,
      line: hits[0]?.line,
    });
  }
  for (const [name, hits] of Object.entries(b.otherSdkUsage)) {
    manual.push({
      severity: 'manual',
      category: 'sdk',
      message: `base44.${name} has no local equivalent; calls will throw until you implement it.`,
      file: hits[0]?.file,
      line: hits[0]?.line,
    });
  }
  if (b.backendFunctions.length > 0) {
    manual.push({
      severity: 'manual',
      category: 'backend-functions',
      message: `${b.backendFunctions.length} file(s) under functions/ (Base44 backend functions) are preserved but not converted.`,
      file: b.backendFunctions[0],
    });
  }
  if (b.configFiles.length > 0) {
    manual.push({
      severity: 'warning',
      category: 'config',
      message: `Base44 config file(s) kept as-is: ${b.configFiles.slice(0, 5).join(', ')}`,
    });
  }
  if (!ctx.frontendConvertible) {
    manual.push({
      severity: 'manual',
      category: 'frontend',
      message: `Framework "${a.framework}" is not supported for automatic Docker packaging; a backend is generated but the frontend must be built/served manually.`,
    });
  }

  step({ id: 'config', stage: 'CONFIG', title: 'Generate Dockerfile, docker-compose.yml, .env.example', automatic: true });
  step({ id: 'validate', stage: 'BUILD_VALIDATE', title: 'Static validation (and optional build)', automatic: true });
  step({ id: 'package', stage: 'PACKAGE', title: 'Package output ZIP', automatic: true });

  const plan: MigrationPlan = { steps, manual: [] };
  ctx.plan = plan;
  for (const m of manual) plan.manual.push(ctx.addFinding(m));
  return plan;
}
