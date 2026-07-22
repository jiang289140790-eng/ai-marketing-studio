# Command Center 架构合并报告

## 目标

不修改本地 `http://localhost:3001/` Command Center，把它的整体运营架构和工作逻辑迁移到线上 GitHub Pages 版 AI Marketing Studio，并与已上线的核心资产模块结合：

- 账号矩阵
- 素材库
- 角色库

## 本次完成

### 1. 线上总控台升级

新增线上 `CommandCenter` 页面，把本地 Command Center 的运营链路抽象为：

`情报发现 → 策略判断 → 内容生产 → 素材生成 → 发布审批 → 复盘学习`

线上首页不再只是简化说明，而是作为 AI Marketing OS 的运营入口。

### 2. 与核心资产模块打通

保留现有真实页面：

- 账号矩阵：`social_accounts`、`account_profiles`、`platform_connections`
- 素材库：`assets`
- 角色库：`characters`

总控台会把这些资产作为 AI 运营链路的一部分显示。

### 3. 新增运营数据视图

新增统一运营数据页 `OpsDataPage`，用于承接本地 Command Center 的核心页面：

- Campaign 与策略
- 内容工厂
- AI 成果
- 发布队列
- 分析优化
- 知识库

这些页面优先读取现有 Supabase 表，不新增数据库。

### 4. 新增线上数据读取层

新增 `ops-service.js`：

- 读取 Command Center 所需的运营表
- 汇总内容、素材、知识记忆
- 兼容表不存在或 RLS 不允许读取的情况，避免页面崩溃

### 5. 修复展示层中文文案

修复本次入口相关的中文乱码：

- 页面标题
- 导航菜单
- 状态标签
- 日期空状态

## 没有做的事

- 没有修改 `E:\projects\video-generator\command-center`
- 没有修改 `localhost:3001`
- 没有新增数据库表
- 没有迁移本地 Express `/api/*` 后端接口
- 没有把任何密钥放进前端

## 当前线上能力

线上站点现在具备：

1. AI Marketing OS 总控台
2. 账号矩阵真实管理
3. 素材库真实管理
4. 角色库真实管理
5. Campaign / 内容 / 发布 / 分析 / 知识库的真实数据视图

## 后续建议

下一步如果要继续靠近 `localhost:3001` 的完整体验，应迁移后端动作能力：

1. `create-campaign` 改为 Supabase Edge Function 或 Agent Runtime
2. `approve-strategy` 改为安全后端动作
3. `approve-publish` 改为 Publish Center 后端动作
4. `/api/mcp/:toolName` 改为正式 MCP / Agent Runtime 调用层

这样线上 GitHub Pages 才能从“可视化运营台”升级为“可执行运营台”。

## 验证

已执行：

- `npm run lint`
- `npm run build`
- `npm run migrations:check`

结果：

- Lint 通过
- Build 通过
- Migration 检查状态：safe
