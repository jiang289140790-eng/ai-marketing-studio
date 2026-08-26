$ErrorActionPreference = 'Stop'
$prepare = Join-Path $PSScriptRoot 'Prepare-RuntimeBundle.ps1'

$configured = & $prepare -ResolveSourceOnly
if ($configured.resolution_source -ne 'project_config') {
    throw "Expected project_config resolution, got $($configured.resolution_source)."
}

$explicit = & $prepare -MarketingStudioMcpDir $configured.path -ResolveSourceOnly
if ($explicit.resolution_source -ne 'explicit_parameter' -or $explicit.path -ne $configured.path) {
    throw 'Explicit source parameter did not take priority.'
}

$failedClosed = $false
try {
    & $prepare -MarketingStudioMcpDir (Join-Path $PSScriptRoot 'missing-source') -ResolveSourceOnly | Out-Null
}
catch {
    $failedClosed = $true
}
if (-not $failedClosed) {
    throw 'Missing explicit source did not fail closed.'
}

[pscustomobject][ordered]@{
    status = 'PASS'
    configured_resolution = $configured.resolution_source
    explicit_resolution = $explicit.resolution_source
    missing_source_blocked = $failedClosed
} | ConvertTo-Json
