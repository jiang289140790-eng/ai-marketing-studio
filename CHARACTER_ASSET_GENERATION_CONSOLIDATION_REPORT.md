# CHARACTER_ASSET_GENERATION_CONSOLIDATION_REPORT

## 交付结论

本次已在不新增数据库表、不新增 migration、不自动调用付费工作流的前提下，完成角色、生成任务和素材三类资产的职责收口：

- **角色库**：管理持续生成身份、LoRA、参考图、推荐工作流和可生成状态。
- **生成任务**：复用现有 `workflow_runs`，展示执行过程、状态、输出与重试入口。
- **素材库**：管理已经生成、上传或导入且可被业务使用的文件。
- **内容工作台**：继续作为选择角色、发起生成和引用素材的生产入口。
- **原“AI成果”入口**：从一级导航移除，旧路由兼容跳转到“生成任务”；旧页面文件保留，便于回滚。

本次没有部署线上环境，也没有写入或删除生产数据。

## 一、真实数据与复用结构

### 角色

复用现有 `characters`，没有建立第二套角色表。角色设定、视觉身份、Prompt、LoRA 信息、推荐工作流和历史摘要仍由该表承载。

### LoRA 与工作流

复用：

- `characters.lora_info`
- `characters.recommended_workflows`
- `comfy_workflows`

可生成状态由页面动态计算，不新增数据库字段。计算依据包括：

1. 角色资料是否完整；
2. 是否有参考图；
3. 是否绑定 LoRA；
4. LoRA 是否具有已验证状态或可识别的文件信息；
5. 是否绑定并启用了推荐工作流；
6. 最近生成测试是否成功。

### 生成任务

当前数据库没有独立 `generation_jobs` 表，因此本次复用现有 `workflow_runs` 作为生成任务数据源，没有创建平行任务体系。

任务列表按以下状态分类：

- 排队中
- 运行中
- 已完成
- 失败
- 已取消

页面展示内容、Campaign、Day、角色、LoRA、工作流、Provider、进度、创建时间、输出结果和下一步操作。原始输入、输出和错误对象只在高级详情中展示。

### 素材

素材库同时兼容：

- `assets`：上传、手动导入等通用素材；
- `asset_library`：生成工作流回传的实际成果。

Campaign、Day、角色、用途、来源和授权声明写入现有 JSON 元数据，不新增字段。生成任务和素材文件保持分离。

## 二、角色库调整

### 角色卡

角色卡现在显示：

- 角色主图
- 角色名称
- 绑定账号
- LoRA 状态
- LoRA 版本
- 基础模型
- 触发词
- 推荐权重
- 默认工作流
- 可生成状态
- 最近验证时间
- 当前阻塞

主要操作统一为：

- 继续配置
- 生成测试
- 编辑
- 查看详情

删除移动到“更多”菜单，并保留确认机制。

### 可生成状态

集中计算并显示：

- 可生成
- 部分可用
- 配置不完整
- 工作流不可用
- LoRA 不可用

“生成测试”只进入内容工作台的安全配置入口，不会自动调用付费工作流。

### 角色详情

详情抽屉提供：

- 角色设定
- 视觉身份
- LoRA 与模型
- 参考图
- 绑定账号
- 工作流
- 生成测试
- 版本历史

UUID、原始 JSON、内部路径等仅在高级模式显示。

### Emma 验证

生产数据能够显示：

- LoRA：Emma S1 SDXL LoRA
- 版本：0.1
- 基础模型：SDXL 1.0 Base
- 触发词：`emma_s1`
- 推荐权重：0.8
- 可调范围：0.7–0.9
- 已验证工作流：`emma_s1_sdxl_t2i_v01`
- 最近成功验证记录和验证图

敏感路径、临时签名地址和凭据不在普通页面展示，也未写入本报告。

### Nina Voss 验证

Nina Voss 当前角色设定较完整，但没有有效 LoRA 配置和推荐工作流。页面会明确显示：

- 状态：LoRA 不可用
- 阻塞：尚未绑定可用 LoRA
- 下一步：继续配置 LoRA 与工作流

不会伪造 LoRA 或把缺失状态显示为可生成。

## 三、素材库调整

### 默认范围

素材库默认聚焦：

- 当前 Campaign
- Day 1
- 当前内容

支持分类：

- 当前内容
- 最终素材
- 生成结果
- 参考素材
- 上传素材
- 图片
- 视频
- 音频

### 素材卡

素材卡显示：

- 业务名称
- 缩略图
- 类型
- Campaign
- Day
- 角色
- 来源
- 用途
- 审核状态
- 是否最终素材
- 关联内容数
- 创建时间

原始文件名、URL、Storage 路径和任务内部信息仅进入高级技术详情。

### 业务命名

对 UUID、`ComfyUI_00002`、`z-image_00004` 等技术文件名生成业务标题，例如：

`Emma · Day 1 候选图 01`

原文件名仍保留在技术详情中，不修改真实文件。

### 上传与 X 链接导入

大型上传表单已从主页面移除。右上角提供：

- 上传素材
- 从 X 链接导入

点击后打开弹窗，并记录：

- 来源
- 授权声明
- Campaign
- Day
- 角色
- 用途

X 链接导入复用现有素材结构，不保存 X Token 或 Secret。

## 四、生成任务页面

新增“生成任务”导航入口，复用 `workflow_runs` 数据和现有路由体系。

任务操作包括：

- 查看结果
- 回传状态
- 重试入口
- 查看技术详情

当前数据库状态约束不支持可靠的取消写入，因此“取消”暂不伪造成功；页面明确提示当前不可用。重试只返回内容工作台确认参数和费用，不自动触发付费任务。

## 五、原 AI 成果页面处理

- 一级导航不再显示职责模糊的“AI成果”。
- 旧 `#/aiworks` 路由兼容重定向到 `#/generation`。
- 原页面源码暂时保留，便于回滚。
- 图片和视频归入素材库。
- 生成过程归入生成任务。
- 账号分析报告继续由账号详情或知识库承载。
- 策略建议继续由策略详情或 AI 复盘承载。
- Agent 执行记录继续由系统状态承载。

## 六、安全限制

- 已被内容引用、已批准或被标记为主素材的记录不能直接删除。
- 删除通用素材前执行引用检查并要求二次确认。
- 工作流生成素材不在素材库中直接物理删除，避免破坏内容和发布关系。
- 未审核素材不会被自动设为最终素材。
- 重新生成通过新任务入口执行，保留原素材和原版本。
- 页面不会自动调用付费工作流。
- 普通模式不展示 Token、Secret、私有路径或临时签名参数。

## 七、主要修改文件

- `src/pages/CharacterLibrary.jsx`
- `src/pages/AssetLibrary.jsx`
- `src/pages/GenerationTasksPage.jsx`
- `src/services/asset-service.js`
- `src/services/ops-service.js`
- `src/utils/character-generation-readiness.js`
- `src/utils/asset-library-model.js`
- `src/data/navigation.js`
- `src/utils/app-route.js`
- `src/App.jsx`
- `src/styles.css`
- `test/character-generation-readiness.test.mjs`
- `test/asset-library-model.test.mjs`

## 八、验证结果

### 自动检查

- `npm test`：通过，47/47
- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm run build`：通过
- `git diff --check`：通过

### 本地入口

- 角色库：HTTP 200
- 素材库：HTTP 200
- 生成任务：HTTP 200

本地地址：

- `http://localhost:3001/ai-marketing-studio/#/characters`
- `http://localhost:3001/ai-marketing-studio/#/assets`
- `http://localhost:3001/ai-marketing-studio/#/generation`

### 页面截图

本轮尝试使用桌面内置浏览器执行真实点击和截图，但浏览器运行内核初始化失败：

`failed to write kernel assets: 系统找不到指定的路径。 (os error 3)`

因此本报告不伪造“实际点击通过”或截图。三个路由已完成服务层 HTTP 验证，最终视觉和交互验收仍需要浏览器运行环境恢复后补测，或由用户刷新上述三个页面并提供截图后继续修正。

## 九、回滚方式

1. 恢复 `CharacterLibrary.jsx` 和 `AssetLibrary.jsx` 的上一版本。
2. 从导航和 `App.jsx` 移除 `generation`，删除 `GenerationTasksPage.jsx`。
3. 移除 `aiworks -> generation` 路由别名即可恢复旧入口。
4. 删除本次新增的两个工具函数及对应测试。
5. 回退本次追加的角色、素材和任务页面样式。

本次没有 migration、数据库结构变更、数据删除或 Secrets 修改，因此回滚不涉及数据库恢复。

## 十、版本信息

- 当前基础提交：`a307f05`
- 当前工作区存在尚未提交的阶段性改动。
- 本轮未主动提交，避免把此前尚未归档的用户改动混入一个未经确认的提交。

