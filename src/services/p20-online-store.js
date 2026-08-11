import { createP19CommandClient } from './p19-server-write-adapter.js';
import { clonePlain, isPlainObject } from './p19-contracts.js';
import { workbenchError } from './p19-workspace-service.js';

function requireData(response, field) {
  const value = response?.data?.[field];
  if (value === undefined) throw workbenchError('ONLINE_RESPONSE_INVALID', `在线响应缺少 ${field}。`);
  return clonePlain(value);
}

export function createP20OnlineStore({ commandClient = createP19CommandClient() } = {}) {
  async function listProjects() {
    const response = await commandClient.invoke('project.list', {});
    const projects = requireData(response, 'projects');
    if (!Array.isArray(projects)) throw workbenchError('ONLINE_RESPONSE_INVALID', '在线项目列表格式无效。');
    return projects;
  }

  async function getProject(projectId) {
    const response = await commandClient.invoke('project.read', { project_id: projectId });
    const project = requireData(response, 'project');
    if (!isPlainObject(project) || project.id !== projectId) {
      throw workbenchError('ONLINE_PROJECT_ID_MISMATCH', '在线项目身份不匹配，已拒绝加载。');
    }
    return project;
  }

  async function execute(command, payload, options) {
    const response = await commandClient.invoke(command, payload, options);
    if (command === 'project.create') {
      const projectId = response?.entity?.id;
      if (!projectId) throw workbenchError('ONLINE_RESPONSE_INVALID', '创建响应缺少项目身份。');
      return getProject(projectId);
    }
    const projectId = payload.project_id || response?.entity?.id;
    return projectId ? getProject(projectId) : null;
  }

  async function importPackage(pkg, options) {
    if (!isPlainObject(pkg) || !isPlainObject(pkg.project) || typeof pkg.project.id !== 'string') {
      throw workbenchError('IMPORT_PACKAGE_INVALID', '在线导入包缺少准确项目身份。');
    }
    const response = await commandClient.invoke('project.import', { package: clonePlain(pkg) }, options);
    if (response?.entity?.id !== pkg.project.id) {
      throw workbenchError('ONLINE_PROJECT_ID_MISMATCH', '在线导入返回的项目身份与已确认备份不一致。');
    }
    return getProject(pkg.project.id);
  }

  return Object.freeze({ execute, getProject, importPackage, listProjects });
}
