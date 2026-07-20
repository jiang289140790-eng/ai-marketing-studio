import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const workflowCategories = [
  'character_generation',
  'motion_transfer',
  'face_swap',
  'clothing_transfer',
  'video_generation',
];

const productionPriority = {
  character_generation: 10,
  face_swap: 30,
  clothing_transfer: 40,
  motion_transfer: 50,
  video_generation: 80,
};

const defaultDirs = [
  'workflows-production',
  'workflows',
  'workflow',
  'comfy-workflows',
  'comfyui-workflows',
  path.join('ComfyUI', 'workflows'),
];

const args = parseArgs(process.argv.slice(2));

async function main() {
  const scanDirs = args.dir.length ? args.dir : defaultDirs;
  const files = scanDirs.flatMap((dir) => findJsonFiles(path.resolve(process.cwd(), dir)));
  const workflows = [];
  const errors = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const workflowJson = JSON.parse(raw);
      const normalized = normalizeWorkflow(file, workflowJson);
      if (args.recommendedOnly && !normalized.recommended) continue;
      workflows.push(normalized);
    } catch (error) {
      errors.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result = {
    scanned_directories: scanDirs,
    scanned_files: files.length,
    parsed_workflows: workflows.length,
    recommended_workflows: workflows.filter((workflow) => workflow.recommended).length,
    categories: countBy(workflows, (workflow) => workflow.category),
    workflows,
    errors,
  };

  if (args.sync) {
    result.sync = await syncWorkflows(workflows);
  }

  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`);
  }

  if (args.json || args.output) {
    console.log(JSON.stringify({
      scanned_files: result.scanned_files,
      parsed_workflows: result.parsed_workflows,
      recommended_workflows: result.recommended_workflows,
      categories: result.categories,
      errors: result.errors.length,
      synced: result.sync?.synced || 0,
    }, null, 2));
  } else {
    printHumanReport(result);
  }
}

function normalizeWorkflow(file, workflowJson) {
  const metadata = getRegistryMetadata(workflowJson);
  const nodes = extractNodes(workflowJson);
  const nodeTexts = nodes.map((node) => [
    node.id,
    node.type,
    node.title,
    node.class_type,
    JSON.stringify(node.inputs || {}),
  ].filter(Boolean).join(' '));
  const haystack = `${path.basename(file)} ${nodeTexts.join(' ')}`.toLowerCase();

  const category = workflowCategories.includes(metadata.category) ? metadata.category : inferCategory(haystack);
  const mode = metadata.mode || (category === 'video_generation' || hasAny(haystack, ['video', 'wanvideo', 'animatediff', 'i2v'])
    ? 'video'
    : 'image');
  const modelFacts = extractModelFacts(nodes, haystack);
  const mergedModelFacts = {
    ...modelFacts,
    checkpoint: metadata.checkpoint || modelFacts.checkpoint,
    checkpoints: unique([metadata.checkpoint, ...(modelFacts.checkpoints || [])]),
    loras: unique([...(toArray(metadata.lora)), ...(toArray(metadata.loras)), ...(modelFacts.loras || [])]),
    controlnets: unique([...(toArray(metadata.controlnet)), ...(toArray(metadata.controlnets)), ...(modelFacts.controlnets || [])]),
  };
  mergedModelFacts.model = metadata.model || inferModel(mergedModelFacts.checkpoint, haystack);
  const nodeMappings = Object.keys(metadata.node_mapping || {}).length
    ? metadata.node_mapping
    : buildNodeMappings(nodes);
  const inputSchema = buildInputSchema(nodeMappings, mergedModelFacts, category, metadata.required_inputs);
  const name = metadata.name || inferName(file, workflowJson);
  const version = metadata.version || inferVersion(file, workflowJson);
  const recommended = isProductionCandidate(category, modelFacts, haystack);

  return {
    source_file: path.relative(process.cwd(), file).replaceAll('\\', '/'),
    name,
    version,
    description: `Imported from ${path.basename(file)} by ComfyUI Workflow Registry.`,
    category,
    mode,
    model: mergedModelFacts.model,
    checkpoint: mergedModelFacts.checkpoint,
    loras: mergedModelFacts.loras,
    controlnets: mergedModelFacts.controlnets,
    workflow_json: stripRegistryMetadata(workflowJson),
    input_schema: inputSchema,
    output_schema: { type: mode === 'video' ? 'video' : 'image' },
    node_mappings: nodeMappings,
    detected_nodes: summarizeNodes(nodes),
    detected_models: mergedModelFacts,
    tags: unique([...(metadata.tags || []), ...buildTags(category, mergedModelFacts, haystack)]),
    priority: Number(metadata.priority || productionPriority[category] || 100),
    status: metadata.status || (recommended ? 'active' : 'draft'),
    recommended,
  };
}

function getRegistryMetadata(workflowJson) {
  const metadata = workflowJson?._registry || workflowJson?.registry || workflowJson?.metadata?.registry || {};
  if (!metadata || typeof metadata !== 'object') return {};
  return metadata;
}

function stripRegistryMetadata(workflowJson) {
  if (!workflowJson || typeof workflowJson !== 'object' || Array.isArray(workflowJson)) return workflowJson;
  const clone = JSON.parse(JSON.stringify(workflowJson));
  delete clone._registry;
  delete clone.registry;
  if (clone.metadata && typeof clone.metadata === 'object') {
    delete clone.metadata.registry;
  }
  return clone;
}

function extractNodes(workflowJson) {
  if (Array.isArray(workflowJson?.nodes)) {
    return workflowJson.nodes.map((node) => ({
      id: String(node.id),
      type: node.type || node.class_type || '',
      title: node.title || node.properties?.['Node name for S&R'] || '',
      class_type: node.type || node.class_type || '',
      inputs: uiInputsToObject(node),
    }));
  }

  if (workflowJson && typeof workflowJson === 'object') {
    return Object.entries(workflowJson)
      .filter(([, value]) => value && typeof value === 'object' && (value.class_type || value.inputs))
      .map(([id, node]) => ({
        id,
        type: node.class_type || node.type || '',
        title: node._meta?.title || node.title || '',
        class_type: node.class_type || node.type || '',
        inputs: node.inputs || {},
      }));
  }

  return [];
}

function uiInputsToObject(node) {
  const values = {};
  const widgets = node.widgets_values || [];
  const inputs = node.inputs || [];
  inputs.forEach((input, index) => {
    if (input?.name && widgets[index] !== undefined) values[input.name] = widgets[index];
  });
  if (node.properties?.values && typeof node.properties.values === 'object') {
    Object.assign(values, node.properties.values);
  }
  return values;
}

function inferName(file, workflowJson) {
  const explicit = workflowJson?.name || workflowJson?.title || workflowJson?.meta?.name;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return path.basename(file, path.extname(file)).replace(/[_-]+/g, ' ');
}

function inferVersion(file, workflowJson) {
  const explicit = workflowJson?.version || workflowJson?.meta?.version;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const match = path.basename(file).match(/(?:v|version)[_-]?(\d+(?:\.\d+)*)/i);
  return match?.[1] || '1.0.0';
}

function inferCategory(text) {
  if (hasAny(text, ['reactor', 'face swap', 'faceswap', 'instantid', 'faceid', 'ipadapter face', 'pulid'])) {
    return 'face_swap';
  }
  if (hasAny(text, ['clothing', 'clothes', 'outfit', 'garment', 'tryon', 'try-on', 'dress', 'inpaint'])) {
    return 'clothing_transfer';
  }
  if (hasAny(text, ['openpose', 'dwpose', 'pose control', 'controlnet pose', 'motion transfer'])) {
    return 'motion_transfer';
  }
  if (hasAny(text, ['video', 'wanvideo', 'hunyuanvideo', 'animatediff', 'svd', 'i2v', 'image to video'])) {
    return 'video_generation';
  }
  return 'character_generation';
}

function extractModelFacts(nodes, haystack) {
  const checkpoints = unique(flatMapInputs(nodes, ['ckpt_name', 'checkpoint', 'checkpoint_name']));
  const unets = unique(flatMapInputs(nodes, ['unet_name', 'model_name']));
  const loras = unique(flatMapInputs(nodes, ['lora_name', 'lora']));
  const controlnets = unique([
    ...flatMapInputs(nodes, ['control_net_name', 'controlnet_name']),
    ...nodes
      .filter((node) => String(node.class_type || node.type).toLowerCase().includes('controlnet'))
      .map((node) => node.title || node.class_type || node.id),
  ]);
  const checkpoint = checkpoints[0] || unets[0] || null;
  const model = inferModel(checkpoint, haystack);

  return {
    model,
    checkpoint,
    checkpoints,
    unets,
    loras,
    controlnets,
  };
}

function inferModel(checkpoint, haystack) {
  const text = `${checkpoint || ''} ${haystack}`.toLowerCase();
  if (text.includes('flux')) return 'Flux';
  if (text.includes('sdxl') || text.includes('xl')) return 'SDXL';
  if (text.includes('wan')) return 'Wan Video';
  if (text.includes('hunyuan')) return 'Hunyuan Video';
  if (text.includes('animatediff')) return 'AnimateDiff';
  if (text.includes('sd15') || text.includes('1.5')) return 'Stable Diffusion 1.5';
  return checkpoint ? 'custom' : null;
}

function buildNodeMappings(nodes) {
  const mappings = {};
  const textNodes = nodes.filter((node) => String(node.class_type || node.type).toLowerCase().includes('cliptextencode'));
  if (textNodes[0]) mappings.positive_prompt = { node_id: textNodes[0].id, input: 'text' };
  if (textNodes[1]) mappings.negative_prompt = { node_id: textNodes[1].id, input: 'text' };

  const sampler = nodes.find((node) => hasInput(node, ['seed', 'steps', 'cfg'])) || null;
  if (sampler) {
    for (const input of ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) {
      if (sampler.inputs?.[input] !== undefined) mappings[input] = { node_id: sampler.id, input };
    }
  }

  const latent = nodes.find((node) => hasInput(node, ['width', 'height', 'batch_size'])) || null;
  if (latent) {
    for (const input of ['width', 'height', 'batch_size']) {
      if (latent.inputs?.[input] !== undefined) mappings[input] = { node_id: latent.id, input };
    }
  }

  const checkpoint = nodes.find((node) => hasInput(node, ['ckpt_name', 'checkpoint', 'unet_name', 'model_name'])) || null;
  if (checkpoint) {
    for (const input of ['ckpt_name', 'checkpoint', 'unet_name', 'model_name']) {
      if (checkpoint.inputs?.[input] !== undefined) {
        mappings.checkpoint = { node_id: checkpoint.id, input };
        break;
      }
    }
  }

  const lora = nodes.find((node) => hasInput(node, ['lora_name', 'lora'])) || null;
  if (lora) {
    for (const input of ['lora_name', 'lora']) {
      if (lora.inputs?.[input] !== undefined) {
        mappings.lora = { node_id: lora.id, input };
        break;
      }
    }
  }

  return mappings;
}

function buildInputSchema(nodeMappings, modelFacts, category, requiredInputs = []) {
  const required = new Set(Array.isArray(requiredInputs) ? requiredInputs : []);
  const properties = {
    positive_prompt: { type: 'string', required: required.has('positive_prompt') || Boolean(nodeMappings.positive_prompt) },
    negative_prompt: { type: 'string', required: required.has('negative_prompt') },
    seed: { type: 'number', required: required.has('seed') },
    width: { type: 'number', required: required.has('width') },
    height: { type: 'number', required: required.has('height') },
    steps: { type: 'number', required: required.has('steps') },
    cfg: { type: 'number', required: required.has('cfg') },
  };

  if (modelFacts.loras.length) {
    properties.lora = { type: 'string', required: false, options: modelFacts.loras };
  }

  return {
    category,
    schema_version: '1.0',
    properties,
  };
}

function summarizeNodes(nodes) {
  const classCounts = countBy(nodes, (node) => node.class_type || node.type || 'unknown');
  return {
    total: nodes.length,
    class_counts: classCounts,
    key_nodes: nodes
      .filter((node) => {
        const text = `${node.class_type} ${node.title}`.toLowerCase();
        return hasAny(text, ['sampler', 'checkpoint', 'lora', 'controlnet', 'cliptextencode', 'saveimage', 'vae']);
      })
      .slice(0, 40)
      .map((node) => ({
        id: node.id,
        class_type: node.class_type || node.type,
        title: node.title || '',
      })),
  };
}

function buildTags(category, modelFacts, haystack) {
  const tags = [category];
  if (modelFacts.model) tags.push(modelFacts.model.toLowerCase().replaceAll(' ', '_'));
  if (modelFacts.loras.length) tags.push('lora');
  if (modelFacts.controlnets.length) tags.push('controlnet');
  if (haystack.includes('flux')) tags.push('flux');
  if (haystack.includes('portrait')) tags.push('portrait');
  if (haystack.includes('ipadapter')) tags.push('ipadapter');
  return unique(tags);
}

function isProductionCandidate(category, modelFacts, haystack) {
  if (!workflowCategories.includes(category)) return false;
  if (category === 'video_generation' && !hasAny(haystack, ['i2v', 'image to video', 'wan', 'animatediff'])) return false;
  if (category === 'character_generation') {
    return modelFacts.model === 'Flux' || modelFacts.loras.length > 0 || hasAny(haystack, ['portrait', 'character']);
  }
  return true;
}

async function syncWorkflows(workflows) {
  const userId = args.userId || process.env.COMFYUI_WORKFLOW_USER_ID;
  if (!userId) {
    throw new Error('Sync requires --user-id or COMFYUI_WORKFLOW_USER_ID.');
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Sync requires SUPABASE_URL/VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let synced = 0;
  const errors = [];

  for (const workflow of workflows) {
    try {
      const existing = await findExistingWorkflow(client, userId, workflow.name, workflow.version);
      const payload = {
        user_id: userId,
        name: workflow.name,
        description: workflow.description,
        mode: workflow.mode,
        version: workflow.version,
        status: workflow.status,
        workflow_json: workflow.workflow_json,
        input_schema: workflow.input_schema,
        output_schema: workflow.output_schema,
        model: workflow.model,
        checkpoint: workflow.checkpoint,
        loras: workflow.loras,
        default_params: {},
        node_mappings: workflow.node_mappings,
        category: workflow.category,
        priority: workflow.priority,
        detected_nodes: workflow.detected_nodes,
        detected_models: workflow.detected_models,
        controlnets: workflow.controlnets,
        tags: workflow.tags,
        last_synced_at: new Date().toISOString(),
      };

      if (existing) {
        const { error } = await client.from('comfy_workflows').update(payload).eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await client.from('comfy_workflows').insert(payload);
        if (error) throw error;
      }
      synced += 1;
    } catch (error) {
      errors.push({
        name: workflow.name,
        version: workflow.version,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { synced, errors };
}

async function findExistingWorkflow(client, userId, name, version) {
  const { data, error } = await client
    .from('comfy_workflows')
    .select('id')
    .eq('user_id', userId)
    .eq('name', name)
    .eq('version', version)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

function findJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) return dir.endsWith('.json') ? [dir] : [];

  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
      results.push(...findJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

function parseArgs(argv) {
  const parsed = {
    dir: [],
    json: false,
    output: '',
    sync: false,
    userId: '',
    recommendedOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') parsed.dir.push(argv[++index]);
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--output') parsed.output = argv[++index];
    else if (arg === '--sync') parsed.sync = true;
    else if (arg === '--user-id') parsed.userId = argv[++index];
    else if (arg === '--recommended-only') parsed.recommendedOnly = true;
    else if (!arg.startsWith('--')) parsed.dir.push(arg);
  }

  return parsed;
}

function hasInput(node, names) {
  return names.some((name) => node.inputs && Object.prototype.hasOwnProperty.call(node.inputs, name));
}

function flatMapInputs(nodes, names) {
  const values = [];
  for (const node of nodes) {
    for (const name of names) {
      const value = node.inputs?.[name];
      if (typeof value === 'string' && value.trim()) values.push(value.trim());
    }
  }
  return values;
}

function hasAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function printHumanReport(result) {
  console.log('# ComfyUI Workflow Registry');
  console.log('');
  console.log(`Scanned files: ${result.scanned_files}`);
  console.log(`Parsed workflows: ${result.parsed_workflows}`);
  console.log(`Recommended workflows: ${result.recommended_workflows}`);
  console.log('');
  for (const workflow of result.workflows) {
    console.log(`- ${workflow.name} v${workflow.version}`);
    console.log(`  category=${workflow.category} mode=${workflow.mode} status=${workflow.status} model=${workflow.model || '-'} checkpoint=${workflow.checkpoint || '-'}`);
    console.log(`  loras=${workflow.loras.length} controlnets=${workflow.controlnets.length} source=${workflow.source_file}`);
  }
  if (result.errors.length) {
    console.log('');
    console.log('## Errors');
    for (const error of result.errors) {
      console.log(`- ${error.file}: ${error.error}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
