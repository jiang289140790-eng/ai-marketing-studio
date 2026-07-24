param(
    [string]$MarketingStudioMcpDir = 'E:\projects\video-generator\mcp-servers\marketing-studio',
    [string]$OutputDir = (Join-Path $PSScriptRoot '.runtime-build')
)

$ErrorActionPreference = 'Stop'

$runtimeDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$bridgeDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$mcpDir = (Resolve-Path -LiteralPath $MarketingStudioMcpDir).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$separator = [System.IO.Path]::DirectorySeparatorChar
$allowedRoot = $runtimeDir.TrimEnd($separator) + $separator

if (-not $outputPath.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDir must stay inside $runtimeDir."
}

if (Test-Path -LiteralPath $outputPath) {
    $resolvedOutput = (Resolve-Path -LiteralPath $outputPath).Path
    if (-not $resolvedOutput.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clean an output path outside the runtime directory.'
    }
    Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
}

New-Item -ItemType Directory -Path $outputPath | Out-Null
$bridgeOutput = New-Item -ItemType Directory -Path (Join-Path $outputPath 'bridge')
$mcpOutput = New-Item -ItemType Directory -Path (Join-Path $outputPath 'marketing-studio-mcp')

function Copy-SafeTree {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$AllowedTopLevel = @()
    )

    $blockedNames = @('.env', '.env.local')
    $blockedSegments = @('node_modules', '.git', 'test', 'tests', 'docs', 'migrations', 'supabase', 'runtime', '.runtime-build')
    Get-ChildItem -LiteralPath $Source -File -Recurse | ForEach-Object {
        $relative = $_.FullName.Substring($Source.Length).TrimStart($separator)
        $segments = $relative -split '[\\/]'
        if ($blockedNames -contains $_.Name -or $_.Name -like '.env.*' -or $_.Extension -eq '.log') { return }
        if ($segments | Where-Object { $blockedSegments -contains $_ }) { return }
        if ($AllowedTopLevel.Count -gt 0 -and $segments.Count -gt 1 -and $AllowedTopLevel -notcontains $segments[0]) { return }
        if ($AllowedTopLevel.Count -gt 0 -and $segments.Count -eq 1 -and @('package.json', 'package-lock.json', 'server.js') -notcontains $_.Name) { return }

        $target = Join-Path $Destination $relative
        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $_.FullName -Destination $target
    }
}

Copy-SafeTree -Source $bridgeDir -Destination $bridgeOutput.FullName
Copy-SafeTree -Source $mcpDir -Destination $mcpOutput.FullName -AllowedTopLevel @('lib', 'agent-runtime')
Copy-Item -LiteralPath (Join-Path $runtimeDir 'Dockerfile') -Destination $outputPath
Copy-Item -LiteralPath (Join-Path $runtimeDir '.dockerignore') -Destination $outputPath

$forbidden = Get-ChildItem -LiteralPath $outputPath -File -Recurse | Where-Object {
    $_.Name -eq '.env' -or $_.Name -like '.env.*'
}
if ($forbidden) {
    throw 'The runtime bundle contains a forbidden environment file.'
}

Write-Output "Runtime bundle ready: $outputPath"
Write-Output ('Build with: docker build -t ai-marketing-studio-runtime "{0}"' -f $outputPath)
