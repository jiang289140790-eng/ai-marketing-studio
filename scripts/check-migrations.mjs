import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const migrationsDir = path.join(root, 'supabase', 'migrations');

/**
 * CREATE TABLE / CREATE POLICY / CREATE INDEX 解析器。
 * - CREATE TABLE 支持任意 schema 限定符（如 `create table ams_private.x`），
 *   键为完整限定名（未限定统一归入 public），绝不把所有表折叠到 schema 名；
 * - CREATE POLICY / DROP POLICY 支持任意 schema 限定符；
 * - 动态 CREATE POLICY（execute format('create policy ...')）按守卫分类：
 *   语句上下文含 pg_policies + policyname + if not exists 的有限动态对账视为
 *   guarded（有界、安全），只把无守卫的动态策略计为 unsafe。
 */
const checks = [
  {
    kind: 'table',
    label: 'CREATE TABLE',
    pattern: /create\s+table\s+(if\s+not\s+exists\s+)?((?:[a-z_][a-z0-9_]*)\s*\.\s*)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      const schema = match[2] ? match[2].replace(/\s+/g, '').replace(/\.$/, '') : 'public';
      return `${schema}.${match[3]}`;
    },
    guarded(match) {
      return Boolean(match[1]);
    },
  },
  {
    kind: 'policy',
    label: 'CREATE POLICY',
    pattern: /create\s+policy\s+"([^"]+)"\s+on\s+((?:[a-z_][a-z0-9_]*)\s*\.\s*)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      const schema = match[2] ? match[2].replace(/\s+/g, '').replace(/\.$/, '') : 'public';
      return `${schema}.${match[3]}.${match[1]}`;
    },
    guarded(_match, _line, context) {
      return hasPolicyGuard(context.sql, context.statementIndex, context.controlSql);
    },
  },
  {
    kind: 'index',
    label: 'CREATE INDEX',
    pattern: /create\s+(?:unique\s+)?index\s+(if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      return match[2];
    },
    guarded(match) {
      return Boolean(match[1]);
    },
  },
  {
    kind: 'alter_policy',
    label: 'ALTER POLICY',
    pattern: /alter\s+policy\s+"([^"]+)"\s+on\s+((?:[a-z_][a-z0-9_]*)\s*\.\s*)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      const schema = match[2] ? match[2].replace(/\s+/g, '').replace(/\.$/, '') : 'public';
      return `${schema}.${match[3]}.${match[1]}`;
    },
    guarded() {
      return false;
    },
  },
  {
    kind: 'drop_policy',
    label: 'DROP POLICY',
    pattern: /drop\s+policy\s+(if\s+exists\s+)?"?([^"\s]+)"?\s+on\s+((?:[a-z_][a-z0-9_]*)\s*\.\s*)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      const schema = match[3] ? match[3].replace(/\s+/g, '').replace(/\.$/, '') : 'public';
      return `${schema}.${match[4]}.${match[2]}`;
    },
    guarded(match) {
      return Boolean(match[1]);
    },
  },
];

/** 动态 CREATE POLICY 语句（execute format(...) 或 execute $tag$ ... $tag$）。 */
const dynamicPolicyPattern = /execute\s+(?:format\s*\()?['$][\s\S]{0,300}?create\s+policy/gi;

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function getLineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function getLineNumber(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return high + 1;
}

function getLine(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end);
}

function getStatement(text, index) {
  const end = text.indexOf(';', index);
  return text.slice(index, end === -1 ? text.length : end + 1);
}

function maskPolicyControlSql(sql) {
  const chars = [...sql];
  const masked = [...sql];
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
    }
  };
  let index = 0;
  let codeDollarTag = null;
  while (index < chars.length) {
    if (chars[index] === '-' && chars[index + 1] === '-') {
      const end = sql.indexOf('\n', index + 2);
      const stop = end === -1 ? chars.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (chars[index] === '/' && chars[index + 1] === '*') {
      let depth = 1;
      let end = index + 2;
      while (end < chars.length && depth > 0) {
        if (chars[end] === '/' && chars[end + 1] === '*') { depth += 1; end += 2; continue; }
        if (chars[end] === '*' && chars[end + 1] === '/') { depth -= 1; end += 2; continue; }
        end += 1;
      }
      blank(index, end);
      index = end;
      continue;
    }
    if (chars[index] === "'" || chars[index] === '"') {
      const quote = chars[index];
      let end = index + 1;
      while (end < chars.length) {
        if (chars[end] === quote && chars[end + 1] === quote) { end += 2; continue; }
        if (chars[end] === quote) { end += 1; break; }
        end += 1;
      }
      blank(index, end);
      index = end;
      continue;
    }
    if (chars[index] === '$') {
      const delimiter = sql.slice(index).match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/i)?.[0] || null;
      if (delimiter) {
        if (codeDollarTag === delimiter) {
          blank(index, index + delimiter.length);
          codeDollarTag = null;
          index += delimiter.length;
          continue;
        }
        const preceding = sql.slice(0, index).match(/([a-z_][a-z0-9_]*)\s*$/i)?.[1]?.toLowerCase() || '';
        if (codeDollarTag === null && (preceding === 'do' || preceding === 'as')) {
          blank(index, index + delimiter.length);
          codeDollarTag = delimiter;
          index += delimiter.length;
          continue;
        }
        const close = sql.indexOf(delimiter, index + delimiter.length);
        const end = close === -1 ? chars.length : close + delimiter.length;
        blank(index, end);
        index = end;
        continue;
      }
    }
    index += 1;
  }
  return masked.join('');
}

function hasPolicyGuard(sql, statementIndex, controlSql = maskPolicyControlSql(sql)) {
  const prefix = controlSql.slice(0, statementIndex);
  const stack = [];
  const tokenPattern = /\bend\s+if\s*;|\bif\s+not\s+exists\b|\bif\b/gi;
  let token;
  while ((token = tokenPattern.exec(prefix))) {
    const normalized = token[0].toLowerCase();
    if (normalized.startsWith('end')) {
      stack.pop();
      continue;
    }
    if (normalized.includes('not')) {
      const thenIndex = controlSql.toLowerCase().indexOf('then', token.index + token[0].length);
      const condition = thenIndex >= 0 && thenIndex < statementIndex
        ? controlSql.slice(token.index, thenIndex)
        : '';
      stack.push({ guarded: condition.toLowerCase().includes('from pg_policies') && condition.toLowerCase().includes('policyname') });
    } else {
      stack.push({ guarded: false });
    }
  }
  return stack.some((entry) => entry.guarded);
}

/**
 * 分析一组迁移文件（{name, sql}[]），返回统计与不安全分类。
 * 纯函数：可由 CLI（main）与 node:test 直接调用。
 */
export function analyzeSqlFiles(files) {
  const findings = [];
  const dynamicPolicyStatements = [];

  for (const file of files) {
    const sql = file.sql;
    const controlSql = maskPolicyControlSql(sql);
    const lineStarts = getLineStarts(sql);

    for (const check of checks) {
      check.pattern.lastIndex = 0;
      let match;
      while ((match = check.pattern.exec(sql))) {
        const lineNumber = getLineNumber(lineStarts, match.index);
        const line = getLine(sql, match.index);
        const statement = getStatement(sql, match.index);
        findings.push({
          kind: check.kind,
          label: check.label,
          key: check.key(match),
          file: file.name,
          line: lineNumber,
          guarded: check.guarded(match, line, { sql, controlSql, statementIndex: match.index, statement }),
        });
      }
    }

    dynamicPolicyPattern.lastIndex = 0;
    let dynamicMatch;
    while ((dynamicMatch = dynamicPolicyPattern.exec(sql))) {
      const lineNumber = getLineNumber(lineStarts, dynamicMatch.index);
      // 有界动态对账（pg_policies + policyname + if not exists 守卫）分类为 guarded；
      // 只有无守卫的动态 CREATE POLICY 才是 unsafe。
      dynamicPolicyStatements.push({
        file: file.name,
        line: lineNumber,
        guarded: hasPolicyGuard(sql, dynamicMatch.index, controlSql),
      });
    }
  }

  const grouped = groupBy(findings, (item) => `${item.kind}:${item.key}`);
  const duplicates = [...grouped.values()]
    .filter((items) => items.length > 1)
    .sort((a, b) => a[0].key.localeCompare(b[0].key));

  const duplicatePolicies = duplicates.filter((items) => items[0].kind === 'policy');
  const unsafeDuplicatePolicies = duplicatePolicies.filter((items) => items.some((item) => !item.guarded));
  const duplicateTables = duplicates.filter((items) => items[0].kind === 'table');
  const unsafeDuplicateTables = duplicateTables.filter((items) => items.some((item) => !item.guarded));
  const duplicateIndexes = duplicates.filter((items) => items[0].kind === 'index');
  const unsafeDuplicateIndexes = duplicateIndexes.filter((items) => items.some((item) => !item.guarded));
  const policies = findings.filter((item) => item.kind === 'policy');
  const ordinaryPolicies = policies.filter((item) => !item.guarded);
  const guardedPolicies = policies.filter((item) => item.guarded);
  const unsafeDynamicPolicyStatements = dynamicPolicyStatements.filter((item) => !item.guarded);

  const unsafe = unsafeDuplicatePolicies.length > 0
    || unsafeDuplicateTables.length > 0
    || unsafeDuplicateIndexes.length > 0
    || unsafeDynamicPolicyStatements.length > 0;

  return {
    files: files.map((file) => file.name),
    findings,
    policies,
    ordinaryPolicies,
    guardedPolicies,
    dynamicPolicyStatements,
    unsafeDynamicPolicyStatements,
    duplicatePolicies,
    unsafeDuplicatePolicies,
    duplicateTables,
    unsafeDuplicateTables,
    duplicateIndexes,
    unsafeDuplicateIndexes,
    unsafe,
    statusLabel: unsafe ? 'unsafe' : ordinaryPolicies.length > 0 ? 'warning' : 'safe',
  };
}

export function printReport(result) {
  console.log('# Migration Risk Report');
  console.log('');
  console.log(`Migration files: ${result.files.length}`);
  console.log(`Policy creates: ${result.policies.length}`);
  console.log(`Guarded policy creates: ${result.guardedPolicies.length}`);
  console.log(`Ordinary policy creates: ${result.ordinaryPolicies.length}`);
  console.log(`Dynamic policy statements: ${result.dynamicPolicyStatements.length}`);
  console.log(`Unsafe dynamic policy statements: ${result.unsafeDynamicPolicyStatements.length}`);
  console.log(`Duplicate policies: ${result.duplicatePolicies.length}`);
  console.log(`Unsafe duplicate policies: ${result.unsafeDuplicatePolicies.length}`);
  console.log(`Duplicate tables: ${result.duplicateTables.length}`);
  console.log(`Unsafe duplicate tables: ${result.unsafeDuplicateTables.length}`);
  console.log(`Duplicate indexes: ${result.duplicateIndexes.length}`);
  console.log(`Unsafe duplicate indexes: ${result.unsafeDuplicateIndexes.length}`);
  console.log('');
  console.log(`Overall status: ${result.statusLabel}`);
  console.log('');

  if (result.ordinaryPolicies.length) {
    console.log('## Warning: ordinary CREATE POLICY');
    console.log('');
    for (const item of result.ordinaryPolicies) {
      console.log(`- ${item.key} at ${item.file}:${item.line}`);
    }
    console.log('');
  }

  const guardedDynamic = result.dynamicPolicyStatements.filter((item) => item.guarded);
  if (guardedDynamic.length) {
    console.log('## Bounded dynamic policy reconciliation (guarded, not a failure)');
    console.log('');
    for (const item of guardedDynamic) {
      console.log(`- ${item.file}:${item.line} (pg_policies + policyname + if not exists guard present)`);
    }
    console.log('');
  }

  if (result.unsafeDynamicPolicyStatements.length) {
    console.log('## Unsafe: dynamic CREATE POLICY without guard');
    console.log('');
    for (const item of result.unsafeDynamicPolicyStatements) {
      console.log(`- ${item.file}:${item.line}`);
    }
    console.log('');
  }

  if (result.unsafeDuplicatePolicies.length) {
    console.log('## Unsafe duplicate CREATE POLICY');
    console.log('');
    for (const items of result.unsafeDuplicatePolicies) {
      console.log(`- ${items[0].key}`);
      for (const item of items) {
        console.log(`  - ${item.file}:${item.line} guarded=${item.guarded}`);
      }
    }
    console.log('');
  }

  if (result.unsafeDuplicateTables.length) {
    console.log('## Unsafe duplicate CREATE TABLE');
    console.log('');
    for (const items of result.unsafeDuplicateTables) {
      console.log(`- ${items[0].key}`);
      for (const item of items) {
        console.log(`  - ${item.file}:${item.line} guarded=${item.guarded}`);
      }
    }
    console.log('');
  }

  if (result.unsafeDuplicateIndexes.length) {
    console.log('## Unsafe duplicate CREATE INDEX');
    console.log('');
    for (const items of result.unsafeDuplicateIndexes) {
      console.log(`- ${items[0].key}`);
      for (const item of items) {
        console.log(`  - ${item.file}:${item.line} guarded=${item.guarded}`);
      }
    }
    console.log('');
  }

  if (!result.unsafeDuplicatePolicies.length && !result.unsafeDuplicateTables.length && !result.unsafeDuplicateIndexes.length && !result.unsafeDynamicPolicyStatements.length) {
    console.log('No unsafe duplicate CREATE POLICY / CREATE TABLE / CREATE INDEX and no unguarded dynamic CREATE POLICY detected.');
    console.log('');
  }
}

function main() {
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migration directory not found: ${migrationsDir}`);
    process.exit(2);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ name: file, sql: fs.readFileSync(path.join(migrationsDir, file), 'utf8') }));

  const result = analyzeSqlFiles(files);
  printReport(result);
  if (result.unsafe) process.exit(1);
}

// CLI 入口守卫：仅直接运行脚本时执行（node:test 导入时跳过）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
