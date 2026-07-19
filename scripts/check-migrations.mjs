import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const migrationsDir = path.join(root, 'supabase', 'migrations');

const checks = [
  {
    kind: 'table',
    label: 'CREATE TABLE',
    pattern: /create\s+table\s+(if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      return match[2];
    },
    guarded(match) {
      return Boolean(match[1]);
    },
  },
  {
    kind: 'policy',
    label: 'CREATE POLICY',
    pattern: /create\s+policy\s+"([^"]+)"\s+on\s+((?:public|storage)\.)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      const schema = match[2] ? match[2].replace('.', '') : 'public';
      return `${schema}.${match[3]}.${match[1]}`;
    },
    guarded(_match, _line, context) {
      return hasPolicyGuard(context.before, context.statement);
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
    pattern: /alter\s+policy\s+"([^"]+)"\s+on\s+((?:public|storage)\.)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      const schema = match[2] ? match[2].replace('.', '') : 'public';
      return `${schema}.${match[3]}.${match[1]}`;
    },
    guarded() {
      return false;
    },
  },
  {
    kind: 'drop_policy',
    label: 'DROP POLICY',
    pattern: /drop\s+policy\s+(if\s+exists\s+)?"?([^"\s]+)"?\s+on\s+((?:public|storage)\.)?([a-z_][a-z0-9_]*)/gi,
    key(match) {
      const schema = match[3] ? match[3].replace('.', '') : 'public';
      return `${schema}.${match[4]}.${match[2]}`;
    },
    guarded(match) {
      return Boolean(match[1]);
    },
  },
];

function main() {
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migration directory not found: ${migrationsDir}`);
    process.exit(2);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const findings = [];
  const dynamicPolicyStatements = [];

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const lineStarts = getLineStarts(sql);

    for (const check of checks) {
      check.pattern.lastIndex = 0;
      let match;
      while ((match = check.pattern.exec(sql))) {
        const lineNumber = getLineNumber(lineStarts, match.index);
        const line = getLine(sql, match.index);
        const statement = getStatement(sql, match.index);
        const before = sql.slice(Math.max(0, match.index - 700), match.index);
        findings.push({
          kind: check.kind,
          label: check.label,
          key: check.key(match),
          file,
          line: lineNumber,
          guarded: check.guarded(match, line, { before, statement }),
        });
      }
    }

    const dynamicPolicyPattern = /execute\s+(?:format\s*\()?['$][\s\S]{0,200}?create\s+policy/gi;
    let dynamicMatch;
    while ((dynamicMatch = dynamicPolicyPattern.exec(sql))) {
      dynamicPolicyStatements.push({
        file,
        line: getLineNumber(lineStarts, dynamicMatch.index),
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

  printReport({
    files,
    findings,
    policies,
    ordinaryPolicies,
    guardedPolicies,
    dynamicPolicyStatements,
    duplicatePolicies,
    unsafeDuplicatePolicies,
    duplicateTables,
    unsafeDuplicateTables,
    duplicateIndexes,
    unsafeDuplicateIndexes,
  });

  if (
    unsafeDuplicatePolicies.length > 0 ||
    unsafeDuplicateTables.length > 0 ||
    unsafeDuplicateIndexes.length > 0 ||
    dynamicPolicyStatements.length > 0
  ) {
    process.exit(1);
  }
}

function printReport(result) {
  console.log('# Migration Risk Report');
  console.log('');
  console.log(`Migration files: ${result.files.length}`);
  console.log(`Policy creates: ${result.policies.length}`);
  console.log(`Guarded policy creates: ${result.guardedPolicies.length}`);
  console.log(`Ordinary policy creates: ${result.ordinaryPolicies.length}`);
  console.log(`Dynamic policy statements: ${result.dynamicPolicyStatements.length}`);
  console.log(`Duplicate policies: ${result.duplicatePolicies.length}`);
  console.log(`Unsafe duplicate policies: ${result.unsafeDuplicatePolicies.length}`);
  console.log(`Duplicate tables: ${result.duplicateTables.length}`);
  console.log(`Unsafe duplicate tables: ${result.unsafeDuplicateTables.length}`);
  console.log(`Duplicate indexes: ${result.duplicateIndexes.length}`);
  console.log(`Unsafe duplicate indexes: ${result.unsafeDuplicateIndexes.length}`);
  console.log('');
  console.log(`Overall status: ${statusLabel(result)}`);
  console.log('');

  if (result.ordinaryPolicies.length) {
    console.log('## Warning: ordinary CREATE POLICY');
    console.log('');
    for (const item of result.ordinaryPolicies) {
      console.log(`- ${item.key} at ${item.file}:${item.line}`);
    }
    console.log('');
  }

  if (result.dynamicPolicyStatements.length) {
    console.log('## Unsafe: dynamic CREATE POLICY');
    console.log('');
    for (const item of result.dynamicPolicyStatements) {
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

  if (!result.unsafeDuplicatePolicies.length && !result.unsafeDuplicateTables.length && !result.unsafeDuplicateIndexes.length) {
    console.log('No unsafe duplicate CREATE POLICY / CREATE TABLE / CREATE INDEX statements detected.');
    console.log('');
  }
}

function statusLabel(result) {
  if (
    result.unsafeDuplicatePolicies.length ||
    result.unsafeDuplicateTables.length ||
    result.unsafeDuplicateIndexes.length ||
    result.dynamicPolicyStatements.length
  ) {
    return 'unsafe';
  }

  if (result.ordinaryPolicies.length) {
    return 'warning';
  }

  return 'safe';
}

function hasPolicyGuard(before, statement) {
  const context = `${before}\n${statement}`.toLowerCase();
  return (
    context.includes('from pg_policies') &&
    context.includes('if not exists') &&
    context.includes('policyname')
  );
}

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

main();
