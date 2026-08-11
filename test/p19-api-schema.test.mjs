// P19 Edge Function 客户端路径契约（finding 1）：
// 默认 public 架构无法解析 api.p19_*，因此边界内**每一个 RPC 调用都必须
// 显式 supabase.schema('api').rpc(...)** —— 包括 staging 角色查询
// （api.p19_staging_role）。同时证明客户端路径绝不命名 ams_private、
// 绝不以任何表名访问私有表（无 .from(/.insert(/.update(/.delete()）。
//
// 本测试为源码级 + 适配器级双重证明（index.ts 为 Deno 包装器，不执行；
// 其纯映射逻辑在此以源码提取的规则复现验证，并与命令核心的错误映射一致）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const INDEX_PATH = join(REPO_ROOT, 'supabase', 'functions', 'p19-workspace-command', 'index.ts');
const INDEX_SOURCE = readFileSync(INDEX_PATH, 'utf8');

/** 服务端边界函数白名单（迁移内 service_role 唯一被授予 EXECUTE 的函数）。 */
const BOUNDARY_RPCS = new Set([
  'p20_list_projects',
  'p20_import_project',
  'p19_staging_role',
  'p19_get_project',
  'p19_list_project_entities',
  'p19_apply_entity_write',
  'p19_remove_evidence',
]);

/** 去掉注释后的可执行源码（注释可以描述规则本身，不算客户端路径）。 */
function executableSource(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

test('客户端路径：每个 RPC 调用都显式使用 api 架构（schema("api").rpc）', () => {
  // 客户端显式调用（点语法 .rpc(）只有两处：通用包装器与 staging 角色查询，
  // 两处都必须以 .schema('api') 为前缀（默认 public 架构无法解析 api.p19_*）。
  const dotCalls = [...INDEX_SOURCE.matchAll(/\.rpc\s*\(/g)];
  assert.ok(dotCalls.length >= 2, `客户端必须至少包含 2 个显式 .rpc( 调用，实际 ${dotCalls.length}`);
  for (const match of dotCalls) {
    const before = INDEX_SOURCE.slice(0, match.index);
    assert.ok(
      /\.schema\s*\(\s*['"]api['"]\s*\)\s*$/.test(before),
      `发现未显式使用 api 架构的 RPC 调用（位置 ${match.index}）：${before.slice(-60)}`,
    );
  }
  // 绝不出现裸 supabase.rpc（默认 public 路径无法解析 api.p19_*）。
  assert.ok(!/\bsupabase\s*\.\s*rpc\s*\(/.test(INDEX_SOURCE), '不得存在裸 supabase.rpc 调用');
});

test('客户端路径：所有 RPC 名称都来自边界函数白名单，包括 staging 角色查询', () => {
  // 全部 5 个边界函数调用（4 个经通用包装器 + staging 角色直接调用）必须存在
  // 且名称精确在白名单内。
  const names = [...INDEX_SOURCE.matchAll(/\brpc\s*\(\s*'([a-z0-9_]+)'/g)].map((match) => match[1]);
  assert.ok(names.includes('p19_staging_role'), 'staging 角色查询必须同样走 api 架构 RPC');
  assert.ok(names.length >= 7, `必须覆盖全部 7 个边界函数，实际 ${names.length} 个`);
  for (const name of names) {
    assert.ok(BOUNDARY_RPCS.has(name), `RPC ${name} 不在边界函数白名单内`);
  }
});

test('客户端路径：绝不命名 ams_private，绝不以表名访问私有表', () => {
  // 可执行客户端路径（注释之外）绝不出现 ams_private / 表名 / 表访问 API。
  const executable = executableSource(INDEX_SOURCE);
  assert.ok(!executable.includes('ams_private'), '可执行客户端路径不得命名 ams_private');
  assert.ok(!executable.includes('p19_research_projects_v1'), '不得按表名引用 P19 表');
  assert.ok(!executable.includes('p19_command_ledger_v1'), '不得按表名引用台账表');
  assert.ok(!/\.from\s*\(/.test(executable), '客户端路径不得使用表访问 .from(');
  assert.ok(!/\.insert\s*\(/.test(executable), '客户端路径不得直接 .insert(');
  assert.ok(!/\.update\s*\(/.test(executable), '客户端路径不得直接 .update(');
  assert.ok(!/\.delete\s*\(/.test(executable), '客户端路径不得直接 .delete(');
  // 唯一的数据访问面就是 api 架构的边界函数（含 staging 角色）。
  assert.ok(!/\.schema\s*\(\s*(?!['"]api['"]\s*\)\s*\.\s*rpc\b)/.test(executable), '除 api 架构外不得使用其他 schema 调用');
});

test('适配器映射：边界 P19/P20_<CODE> 错误映射为有界公开错误码，绝不降级为 INTERNAL_ERROR', () => {
  // 复现 index.ts mapBoundaryError 的映射规则（源码必须同时携带 P19/P20 前缀提取）。
  assert.ok(INDEX_SOURCE.includes('/P(?:19|20)_([A-Z_]+)/'), '源码必须包含 P19/P20_<CODE> 前缀提取规则');
  const extract = (message) => {
    const matched = String(message).match(/P(?:19|20)_([A-Z_]+)/);
    return matched ? matched[1] : null;
  };
  // SQL 边界抛出的 P19_PROJECT_REVISION_STALE / P19_PROJECT_ARCHIVED /
  // P19_EVIDENCE_NOT_FOUND / P19_PAYLOAD_HASH_MISMATCH 全部映射为有界代码。
  assert.equal(extract('P19_PROJECT_REVISION_STALE'), 'PROJECT_REVISION_STALE');
  assert.equal(extract('P19_PROJECT_ARCHIVED'), 'PROJECT_ARCHIVED');
  assert.equal(extract('P19_EVIDENCE_NOT_FOUND'), 'EVIDENCE_NOT_FOUND');
  assert.equal(extract('P19_PAYLOAD_HASH_MISMATCH'), 'PAYLOAD_HASH_MISMATCH');
  assert.equal(extract('P20_IMPORT_PROJECT_COLLISION'), 'IMPORT_PROJECT_COLLISION');
  assert.equal(extract('connection refused'), null, '非 P19/P20_ 前缀错误不得映射为有界码');
});

test('适配器映射：PROJECT_REVISION_STALE 是 409-equivalent，绝不返回 INTERNAL_ERROR(500)', () => {
  // index.ts 必须有界状态映射表且把 PROJECT_REVISION_STALE 映射到 409。
  assert.ok(INDEX_SOURCE.includes('BOUNDED_STATUS'), '必须存在有界状态映射表');
  assert.ok(INDEX_SOURCE.includes('PROJECT_REVISION_STALE: 409'), 'PROJECT_REVISION_STALE 必须映射为 409');
  // 有界失败绝不落入 INTERNAL_ERROR 分支：INTERNAL_ERROR 只用于非边界异常
  // （catch-all 处理器本身，取其最后一次出现处）。
  assert.ok(INDEX_SOURCE.includes("code: 'INTERNAL_ERROR'"), 'INTERNAL_ERROR 分支必须存在（只用于非边界异常）');
  const internalSection = INDEX_SOURCE.slice(INDEX_SOURCE.lastIndexOf("code: 'INTERNAL_ERROR'"));
  assert.ok(!internalSection.includes('PROJECT_REVISION_STALE'), 'INTERNAL_ERROR 分支不得处理修订冲突');
  assert.ok(/BOUNDED_STATUS\[result\.code\] \|\| 400/.test(INDEX_SOURCE), '有界失败必须按映射表选择状态');
});

test('Edge Function：未知内部错误只返回固定脱敏文案', () => {
  const internalSection = INDEX_SOURCE.slice(INDEX_SOURCE.lastIndexOf('catch (error)'));
  assert.ok(internalSection.includes('内部细节已隐藏'));
  assert.ok(!internalSection.includes('error.message'));
  assert.ok(!internalSection.includes('issues: [message.slice'));
});

test('客户端路径：认证错误有界，未知服务端错误使用固定有界脱敏文案', () => {
  assert.ok(INDEX_SOURCE.includes('.slice(0, 200)'), '认证错误消息必须截断');
  const message = '服务暂时无法完成该命令；内部细节已隐藏，请稍后重试或联系管理员。';
  assert.ok(message.length <= 300, '固定服务端错误消息必须保持有界');
  assert.ok(INDEX_SOURCE.includes(`const message = '${message}'`), '服务端必须返回固定脱敏文案');
});
