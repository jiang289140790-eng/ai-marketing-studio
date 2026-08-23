import { createHash } from 'node:crypto';
import { WORKFLOW_BY_ID, WORKFLOW_CATALOG_VERSION, WORKFLOW_IDS } from './workflow-catalog.mjs';

export const CAPABILITY_MANIFEST_SCHEMA_VERSION = 'ams_harness_capability_manifest_v1';
export const CAPABILITY_REGISTRY_VERSION = 'h2_capability_registry_v1';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function slotView(slot) {
  return {
    type: slot.type,
    required: slot.required === true,
    ...(slot.values ? { values: [...slot.values] } : {}),
    ...(Number.isInteger(slot.min) ? { min: slot.min } : {}),
    ...(Number.isInteger(slot.max) ? { max: slot.max } : {}),
    ...(slot.default !== undefined ? { default: slot.default } : {}),
    note: String(slot.note || '').slice(0, 240),
  };
}

export function buildCapabilityManifest() {
  const capabilities = WORKFLOW_IDS.map((id) => {
    const workflow = WORKFLOW_BY_ID[id];
    const steps = workflow.steps.map((step) => ({
      operation: step.operation || null,
      approval: [...step.approval].sort(),
      cost: step.cost === true,
      write: step.write === true,
      terminal_artifact: step.terminal_artifact || null,
    }));
    return {
      id,
      title: workflow.title,
      description: workflow.description,
      slots: Object.fromEntries(Object.entries(workflow.slots).map(([key, value]) => [key, slotView(value)])),
      approvals: [...new Set(steps.flatMap((step) => step.approval))].sort(),
      paid: steps.some((step) => step.cost),
      writes: steps.some((step) => step.write),
      operations: [...new Set(steps.map((step) => step.operation).filter(Boolean))],
      terminal_artifacts: [...workflow.terminal_artifacts],
    };
  });
  const body = {
    schema_version: CAPABILITY_MANIFEST_SCHEMA_VERSION,
    registry_version: CAPABILITY_REGISTRY_VERSION,
    workflow_catalog_version: WORKFLOW_CATALOG_VERSION,
    capabilities,
  };
  return Object.freeze({ ...body, fingerprint: createHash('sha256').update(canonical(body)).digest('hex') });
}

export function validateCapabilityManifest(manifest) {
  const expected = buildCapabilityManifest();
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, code: 'CAPABILITY_MANIFEST_INVALID' };
  if (manifest.schema_version !== expected.schema_version) return { ok: false, code: 'CAPABILITY_MANIFEST_SCHEMA_MISMATCH' };
  if (manifest.registry_version !== expected.registry_version || manifest.workflow_catalog_version !== expected.workflow_catalog_version) {
    return { ok: false, code: 'CAPABILITY_MANIFEST_VERSION_MISMATCH' };
  }
  if (manifest.fingerprint !== expected.fingerprint || canonical(manifest.capabilities) !== canonical(expected.capabilities)) {
    return { ok: false, code: 'CAPABILITY_MANIFEST_DRIFT' };
  }
  return { ok: true, value: expected };
}

export function capabilityForWorkflow(manifest, workflowId) {
  return manifest?.capabilities?.find((entry) => entry.id === workflowId) || null;
}
