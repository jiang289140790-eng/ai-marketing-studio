# Harness 本地大文件存储约定

## 目标

DeepSeek Harness 运行在阿里云私有容器中，云端工作区只适合保存轻量会话、插件配置和短期执行缓存。图片、视频、导出包、参考素材等大文件统一放在本机 F 盘，避免把阿里云系统盘撑爆。

## 本机目录

默认根目录：

```text
F:\AI-Marketing-Studio
```

目录用途：

| 目录 | 用途 |
| --- | --- |
| `workspace` | 本机临时工作区，只放可丢弃草稿 |
| `attachments` | 准备上传给 Harness 的图片、视频、参考素材 |
| `artifacts` | 从网站或 Storage 下载回来的生成成品 |
| `exports` | Brief、报告、交接包等导出文件 |
| `cache` | 本机可清理缓存 |
| `handoff` | 给其他工具或人工审核的交接文件 |
| `logs` | 本机诊断摘要，不保存 Secret 或原始敏感响应 |

初始化命令：

```powershell
E:\projects\_h6_release_pages\scripts\prepare-local-harness-storage.ps1
```

## 使用方式

1. 大文件先放入 `F:\AI-Marketing-Studio\attachments`。
2. 需要 Harness 分析时，通过官方 Harness UI 的附件按钮选择文件上传。
3. 需要长期保存的结果，由业务工具写入 Supabase Storage 或 AMS 业务表。
4. 网站预览、下载后的成品可以放入 `F:\AI-Marketing-Studio\artifacts`。

## 边界

- 阿里云容器不能直接读取 Windows `F:\` 盘；必须通过上传、Storage、GitHub 链接或其他明确同步方式传递文件。
- 不把本地 F 盘目录纳入 Git。
- 不把 Secret、Token、Cookie、数据库连接串、生产数据放入该目录。
- 云端 `/workspace` 继续保持只读/轻量，不作为素材仓库。

## 后续如果需要自动同步

可以单独做一个受控同步方案，例如：

- 本机选择文件 → 上传到 Supabase Storage → Harness 使用 Storage 引用；
- 或者本机选择文件 → 生成一次性上传链接 → Harness 读取已授权对象；
- 不建议直接把本机磁盘暴露给公网服务器。
