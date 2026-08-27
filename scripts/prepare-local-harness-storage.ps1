param(
  [string]$Root = "F:\AI-Marketing-Studio"
)

$ErrorActionPreference = "Stop"

$requiredFolders = @(
  "workspace",
  "attachments",
  "artifacts",
  "exports",
  "cache",
  "handoff",
  "logs"
)

foreach ($folder in $requiredFolders) {
  $path = Join-Path -Path $Root -ChildPath $folder
  New-Item -ItemType Directory -Force -Path $path | Out-Null
}

$configPath = Join-Path -Path $Root -ChildPath "local-storage.json"

if (-not (Test-Path -LiteralPath $configPath)) {
  $config = [ordered]@{
    schema_version = 1
    purpose = "AI Marketing Studio local large-file workspace for Harness uploads and artifacts"
    root = $Root
    folders = [ordered]@{
      workspace = (Join-Path -Path $Root -ChildPath "workspace")
      attachments = (Join-Path -Path $Root -ChildPath "attachments")
      artifacts = (Join-Path -Path $Root -ChildPath "artifacts")
      exports = (Join-Path -Path $Root -ChildPath "exports")
      cache = (Join-Path -Path $Root -ChildPath "cache")
      handoff = (Join-Path -Path $Root -ChildPath "handoff")
      logs = (Join-Path -Path $Root -ChildPath "logs")
    }
    rules = @(
      "Keep large local source media here before uploading through Harness or Supabase Storage.",
      "Do not commit files from this folder to Git.",
      "Do not copy secrets, tokens, cookies, database URLs, or production data into this folder.",
      "Aliyun Harness containers should keep only lightweight runtime state; upload selected files explicitly when needed."
    )
  }

  $config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8
}

Write-Host "AI Marketing Studio local storage is ready:"
Write-Host $Root
Get-ChildItem -LiteralPath $Root -Directory | Select-Object Name,FullName
