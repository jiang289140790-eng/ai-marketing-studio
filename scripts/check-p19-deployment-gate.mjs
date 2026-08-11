// P19 本地部署历史门禁：P19 只有在该迁移目录与已验收的规范历史完全一致时
// 才可被视为可部署（deployable）。
//
// 门禁规则（全部 fail closed）：
// 1. 已验收规范清单（39 个 P17 迁移 + 4 个 P17 SQL 测试）中的每个文件都必须
//    存在且 SHA-256 与内嵌清单逐字节一致 —— 任何缺失或内容漂移都使 P19 不可部署；
// 2. 若迁移目录记录有任何过时时间戳变体（旧的 5 个时间戳前缀），立即失败 ——
//    它们与规范版本并存会造成升级歧义（重复对象/顺序冲突）；
// 3. 迁移目录不允许存在规范 39 + P19 迁移之外的任何迁移文件（未知历史同样
//    会造成升级歧义）；
// 4. P19 迁移文件本身必须存在（P19 部署的前提）。
//
// 本脚本只做本地确定性校验：不连接任何远程系统、不执行任何迁移、不写任何
// 数据库。`npm run migrations:check` 单独负责语句级风险扫描，两者互补。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 已验收规范迁移清单（来自 E:/projects/_p17b0_isolated_cont2/supabase，43/43 逐字节一致）。 */
export const CANONICAL_MIGRATIONS = Object.freeze([
  ['202607190001_initial_schema.sql', 'bc36506b9f68a130165540b266bfd7c67aa64fca848f682955cd463ef574e537'],
  ['202607190002_workspace_taxonomy_upgrade.sql', '0d47693eb17738172b7474b0198e498860717b0f6f9ca01da9450713dcf674f4'],
  ['202607190003_content_asset_system.sql', '03e01879299b58477f6d44ec0debe9bd7174d34291dbc81282f1e36d4a9f0e14'],
  ['202607190004_workflow_runtime_center.sql', '83aed110270d3faa52cd406ab2b34884c76a638821adb0c60a6df2da9d05b23c'],
  ['20260719081338_agent_dispatch_center.sql', 'ff36711548b491693ab022fbc17a0830bae36554dffa5ff9cc80ec72a42e3490'],
  ['20260719082436_content_intelligence_center.sql', '827d2c1af920edb55f2b60e2a5df4bda015a1175c83f65726088974e4d2556da'],
  ['20260719083243_social_intelligence_collector.sql', 'b5387037684b38444001ca3c7090fd37b8abcdca0266702211b04bf730355065'],
  ['20260719083854_automation_orchestrator.sql', '8ca4dcd30547b7c6f964ce27dd96215ef25c99d83bf8ac873a745e11756504fb'],
  ['20260719085024_automation_real_runner.sql', '66ab92b68ced80843c13844736f1c9ba8c1f7dfa4a3d001e5552ed99b300ef61'],
  ['20260719085554_telegram_collector_adapter.sql', '0cc727d11d8f6031f95f9fe5219b35bb8a74c243ca8b7e4f51b047b2ce877aae'],
  ['20260719090441_social_platform_integration_base.sql', '12bb91b37fefe008ec6be51f356870949bc0fd6c712b3408840ce1f7a957d06b'],
  ['20260719091213_publish_center_base.sql', 'f8568a30adb920fc0fafac3dcc0b0cd148b1566d88b3812caaacb661b3ac664e'],
  ['20260719092038_content_performance_analytics.sql', '99980a19c36d5d0c05e49c88bd260d1400d0a54cc1315c39bd9d4157899b6925'],
  ['20260719093509_telegram_feedback_conversion_loop.sql', '8b8711407bb6919d6b53d3910cb2b4b7be7b3450c2d5c3c900f8b5084f1cfba2'],
  ['20260719094321_production_stability_hardening.sql', 'f0b8a4f5ac56e33a7d690c9343e4fb0920e108c0ec2a6f11cc4f157540d6db02'],
  ['20260719104342_personal_ops_phase2_foundation.sql', '74d456a67d04c2faf566950e09b109958c410566efb814d66e36a28e80f44cf4'],
  ['20260719110000_p17_staging_public_default_acl_guard.sql', '81a7358f26cf92264a18294428c672fb1d0c2e0454a63f47df9c1d2da916c462'],
  ['20260720060033_phase3_2_analysis_agent_ai_gateway.sql', '69dc41a91294f1777b49ca3092c81dfde87acb2c34f44a210e8fb994025a70f6'],
  ['20260720071542_phase3_4_content_generation_agent.sql', '98522137eabf0fa7b7cbcf7de229b4cda2fdd10615662cad55fe1831a781da45'],
  ['20260720073957_account_intelligence_architecture.sql', 'e31a88d82cb5e3073e016a69f5da947cdc8cdf4791b0591fdb6219162b9e0a7f'],
  ['20260720074218_phase3_7_comfyui_asset_generation_mvp.sql', '7e10f349d1bda7b41930f3f14ea1876eca65c46b8bc38e0287643d8a7676bb70'],
  ['20260720080512_phase3_7_2_comfy_workflow_registry.sql', '45e9085b9fb3afb0ddabee48f57010d5c54a3fb3a190b3ec55e06d20962d2629'],
  ['20260720112159_phase3_8_1_telegram_platform_layer.sql', '399686692138c43710457c27583bf6e8ca298700d6f430af1fad4746264a6b8c'],
  ['20260720114840_phase3_10_ai_operation_loop.sql', '4034ad363654ad8d1ebd34bd42560a5d1c71051f8e2759a31336d94190f75107'],
  ['20260722023000_ops_execution_gateway.sql', 'f5ca910a2495395ae7290be111eed183f139ca66eaebf3647c714cfcf481d3e0'],
  ['20260722033000_ops_business_tables_and_rls_hardening.sql', '9458bcd3d07779f198e3ff29e68af61974486495e53dda3c62562f2df64c0b15'],
  ['20260722124304_allow_authenticated_read_knowledge_vault.sql', '1c573dbd8c42dfdbce312a430b9aa5dc751183ace4cd0e58e3839f28252e2c8a'],
  ['20260722134135_allow_authenticated_read_learning_memory.sql', '558ac56bd6e204cff91754f6005a3101b640b8f7417b505c2edc0f871536253b'],
  ['20260722135312_support_discord_and_read_business_intelligence.sql', '86d4796696485adcf5152f4483ba9d4399065e2d93468bb13117c4381bef4ee7'],
  ['20260722142508_hard_finish_security_rls_and_search_path.sql', '33d8f79d0090b3bd021c0ab9ffdae1cec0ef1c27ffb311c09285ace74fab0c8a'],
  ['20260722142548_restore_vector_operator_search_path.sql', '92a5ee0eaa39ddc3f13364482afa23648872a68787e9da6195abb16be0ee2127'],
  ['20260724133825_fix_content_packages_update_policy.sql', '4e05913353cfee1377652db44e0eacfe2f4196a4f4034dd903b25532b0a992ee'],
  ['20260725043427_day1_publish_state_machine.sql', 'fb79d1d8d1f3f3f80b85a604a4bf9b8977a1ccd05c51430760de390b19b24ff4'],
  ['20260810143859_p17_reconcile_out_of_band_foundations.sql', '658b1f3a9129c5b42fd3561f2333aae5ae04b1e489108fc6206f506bebd9db59'],
  ['20260810145429_p17_default_privileges_and_api_schema.sql', 'f54e7151007310f3007426e3b5adab0c156422c2bf69e818cbd99fa285aa3018'],
  ['20260810145431_p17_staging_access_and_roles.sql', '62cab851546cec515f59721843396ae72908958bf071c7536cb16bddef69db3a'],
  ['20260810145433_p17_ke_contract_v1.sql', 'e86fead730f29f0d07356088304ce27dbc559f610051ef5cf674b8b894e67624'],
  ['20260810145434_p17_vg_lineage_contract_v1.sql', '02b739d858a7f1a6fe36aa31636d2e707cb05068fc6208668bb90a84052d8f16'],
  ['20260811012710_p17_staging_explicit_acl_reconciliation.sql', '58a3352e5b9b04c116153af161b4e9982f999b19ad7263de0ab4428cb0539d03'],
]);

/** 已验收规范 SQL 测试清单。 */
export const CANONICAL_SQL_TESTS = Object.freeze([
  ['p17_b0_ke_p5_p16_contract.test.sql', '94a1fb030d56880a12002da1e92b46aae1deb5e75b5694db3442e3138ff23504'],
  ['p17_b0_rls_grant_isolation.test.sql', '14f1b99c7e278fcfa8bd0db8c86e1427eee205da1e6c51c024e767f7f31b5760'],
  ['p17_b0_schema_contract.test.sql', 'd5ff778840380f091c208c51a3fbfab84f2d6cfbd340a346dce1d648ef485321'],
  ['p17_b1e_acl_reconciliation.test.sql', 'a215a825c5722f65144bf0585d2da57e01cd2fcf3c4a7456567ef35d4ac4072a'],
]);

/** 过时时间戳变体前缀（已验收规范版本替代了这些旧时间戳，绝不能再次出现）。 */
export const OBSOLETE_MIGRATION_PREFIXES = Object.freeze([
  '20260722141035',
  '20260722142451',
  '20260722142535',
  '20260724133735',
  '20260725043407',
]);

export const P19_MIGRATION_NAME = '20260812000000_p19_workspace_command_contract_v1.sql';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listSql(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
}

/**
 * 确定性部署历史门禁（纯函数，可注入清单以便测试）。
 * 返回 { ok, deployable, issues: string[] }；任何一条规则不满足都 fail closed。
 */
export function checkDeploymentGate({
  migrationsDir,
  testsDir,
  migrationsManifest = CANONICAL_MIGRATIONS,
  testsManifest = CANONICAL_SQL_TESTS,
  obsoletePrefixes = OBSOLETE_MIGRATION_PREFIXES,
  p19MigrationName = P19_MIGRATION_NAME,
}) {
  const issues = [];
  const migrationFiles = listSql(migrationsDir);
  const testFiles = listSql(testsDir);

  // 1. 规范迁移逐个存在且哈希精确一致。
  for (const [name, expectedHash] of migrationsManifest) {
    if (!migrationFiles.includes(name)) {
      issues.push(`规范迁移缺失：${name}`);
      continue;
    }
    const actual = sha256File(path.join(migrationsDir, name));
    if (actual !== expectedHash) {
      issues.push(`规范迁移哈希漂移：${name}（期望 ${expectedHash.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）`);
    }
  }

  // 2. 过时时间戳变体 fail closed。
  for (const file of migrationFiles) {
    if (obsoletePrefixes.some((prefix) => file.startsWith(prefix))) {
      issues.push(`检测到过时时间戳变体（与规范历史并存会造成升级歧义）：${file}`);
    }
  }

  // 3. 迁移目录必须是「规范 39 + P19 迁移」的精确集合。
  const canonicalNames = new Set(migrationsManifest.map(([name]) => name));
  for (const file of migrationFiles) {
    if (file === p19MigrationName) continue;
    if (!canonicalNames.has(file)) {
      issues.push(`迁移目录存在规范历史之外的未知迁移（升级歧义，fail closed）：${file}`);
    }
  }

  // 4. P19 迁移必须存在（P19 可部署的前提）。
  if (!migrationFiles.includes(p19MigrationName)) {
    issues.push(`P19 迁移缺失：${p19MigrationName}`);
  }

  // 5. 规范 SQL 测试逐个存在且哈希精确一致（P19 验收前提）。
  for (const [name, expectedHash] of testsManifest) {
    if (!testFiles.includes(name)) {
      issues.push(`规范 SQL 测试缺失：${name}`);
      continue;
    }
    const actual = sha256File(path.join(testsDir, name));
    if (actual !== expectedHash) {
      issues.push(`规范 SQL 测试哈希漂移：${name}（期望 ${expectedHash.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）`);
    }
  }

  // 6. 测试目录只允许规范测试 + P19 测试（p19_*.test.sql）。
  for (const file of testFiles) {
    const isCanonical = testsManifest.some(([name]) => name === file);
    if (!isCanonical && !file.startsWith('p19_')) {
      issues.push(`测试目录存在未登记文件：${file}`);
    }
  }

  return { ok: issues.length === 0, deployable: issues.length === 0, issues };
}

function main() {
  const root = process.cwd();
  const result = checkDeploymentGate({
    migrationsDir: path.join(root, 'supabase', 'migrations'),
    testsDir: path.join(root, 'supabase', 'tests'),
  });

  console.log('# P19 Deployment History Gate');
  console.log('');
  console.log(`Canonical migrations: ${CANONICAL_MIGRATIONS.length}`);
  console.log(`Canonical SQL tests: ${CANONICAL_SQL_TESTS.length}`);
  console.log(`P19 migration: ${P19_MIGRATION_NAME}`);
  console.log(`Obsolete variant prefixes (must never be recorded): ${OBSOLETE_MIGRATION_PREFIXES.length}`);
  console.log('');
  if (result.deployable) {
    console.log('Gate: PASS — 迁移历史与已验收规范 39-版本集合完全一致，无过时时间戳变体，P19 可部署。');
    console.log('（部署前仍需满足其余 P19 部署门禁：边界函数部署与端到端验收，见完成报告。）');
    process.exit(0);
  }
  console.log('Gate: FAIL (fail closed) — 以下问题使 P19 不可部署：');
  console.log('');
  for (const issue of result.issues) console.log(`- ${issue}`);
  process.exit(1);
}

// CLI 入口守卫：仅直接运行脚本时执行（node:test 导入时跳过）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
