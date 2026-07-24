param(
  [string]$ProjectRef = "qtrlymiqohbjvklwegsw",
  [Parameter(Mandatory = $true)]
  [string]$Email,
  [string]$ContentPackageId = "85429419-9a27-4726-8026-30712f14da88",
  [string]$SelectedAssetId = "6f2eef79-fc6a-4d56-b201-69ad8004e46f"
)

$ErrorActionPreference = "Stop"
$baseUrl = "https://$ProjectRef.supabase.co"

function Get-ProjectKeys {
  $raw = supabase projects api-keys --project-ref $ProjectRef --reveal --output json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    throw "Unable to retrieve Supabase API keys."
  }

  $keys = $raw | ConvertFrom-Json
  $anon = $keys | Where-Object { $_.name -eq "anon" -and $_.api_key } | Select-Object -First 1
  $service = $keys | Where-Object { $_.name -eq "service_role" -and $_.api_key } | Select-Object -First 1
  if (-not $anon -or -not $service) {
    throw "Required Supabase legacy API keys are unavailable."
  }
  return @{
    Anon = [string]$anon.api_key
    Service = [string]$service.api_key
  }
}

function New-AcceptanceSession([hashtable]$keys) {
  $adminHeaders = @{
    apikey = $keys.Service
    Authorization = "Bearer $($keys.Service)"
    "Content-Type" = "application/json"
  }
  $link = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/admin/generate_link" -Headers $adminHeaders -Body (@{
    type = "magiclink"
    email = $Email
  } | ConvertTo-Json -Compress)
  if (-not $link.hashed_token) {
    throw "Supabase did not return a one-time verification token."
  }

  $verifyHeaders = @{
    apikey = $keys.Anon
    "Content-Type" = "application/json"
  }
  $session = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/verify" -Headers $verifyHeaders -Body (@{
    type = "magiclink"
    token_hash = [string]$link.hashed_token
  } | ConvertTo-Json -Compress)
  if (-not $session.access_token) {
    throw "Unable to create the short-lived acceptance session."
  }
  return [string]$session.access_token
}

function Invoke-OpsAction(
  [string]$AccessToken,
  [string]$Action,
  [string]$ResourceType,
  [string]$ResourceId,
  [hashtable]$Payload
) {
  $key = "acceptance:${Action}:${ResourceId}:$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  $headers = @{
    apikey = $script:keys.Anon
    Authorization = "Bearer $AccessToken"
    "Content-Type" = "application/json"
    "x-idempotency-key" = $key
  }
  $body = @{
    action = $Action
    resourceType = $ResourceType
    resourceId = $ResourceId
    payload = $Payload
    idempotencyKey = $key
  } | ConvertTo-Json -Depth 10 -Compress

  $response = Invoke-RestMethod -Method Post -Uri "$baseUrl/functions/v1/ops-execute" -Headers $headers -Body $body
  if (-not $response.run_id) {
    throw "ops-execute did not return a run ID for $Action."
  }
  return Wait-OpsRun -AccessToken $AccessToken -RunId ([string]$response.run_id)
}

function Wait-OpsRun([string]$AccessToken, [string]$RunId) {
  $headers = @{
    apikey = $script:keys.Anon
    Authorization = "Bearer $AccessToken"
  }
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $response = Invoke-RestMethod -Method Get -Uri "$baseUrl/functions/v1/ops-status?run_id=$RunId" -Headers $headers
    if ($response.run.status -in @("completed", "failed", "cancelled")) {
      return $response.run
    }
    Start-Sleep -Milliseconds 750
  }
  throw "Timed out waiting for ops run $RunId."
}

$script:keys = Get-ProjectKeys
$accessToken = New-AcceptanceSession -keys $script:keys

$finalizeRun = Invoke-OpsAction -AccessToken $accessToken `
  -Action "finalize_content_package" `
  -ResourceType "content_package" `
  -ResourceId $ContentPackageId `
  -Payload @{
    content_package_id = $ContentPackageId
    selected_asset_id = $SelectedAssetId
    final_body = "Bridge public HTTPS acceptance test. Dry-run and preflight only; do not publish externally."
    final_cta = "No external action."
    scheduled_at = $null
    platform_account_id = $null
  }

if ($finalizeRun.status -ne "completed" -or -not $finalizeRun.result_summary.publish_task_id) {
  throw "Finalize action failed: $($finalizeRun.error_message)"
}
$publishTaskId = [string]$finalizeRun.result_summary.publish_task_id

$approveRun = Invoke-OpsAction -AccessToken $accessToken `
  -Action "approve_publish" `
  -ResourceType "publish_task" `
  -ResourceId $publishTaskId `
  -Payload @{
    publish_task_id = $publishTaskId
    approved_by = "codex-safe-dry-run"
    feedback = "Public Bridge acceptance test. Preflight and dry-run only."
  }

if ($approveRun.status -ne "completed") {
  throw "Publish approval failed: $($approveRun.error_message)"
}

$executeRun = Invoke-OpsAction -AccessToken $accessToken `
  -Action "execute_publish" `
  -ResourceType "publish_task" `
  -ResourceId $publishTaskId `
  -Payload @{
    publish_task_id = $publishTaskId
    dry_run = $true
    preflight_only = $true
    human_confirmed = $false
  }

[pscustomobject]@{
  ok = ($executeRun.status -eq "completed")
  publish_task_id = $publishTaskId
  finalize_run_id = $finalizeRun.id
  finalize_status = $finalizeRun.status
  approve_run_id = $approveRun.id
  approve_status = $approveRun.status
  execute_run_id = $executeRun.id
  execute_status = $executeRun.status
  execute_result = $executeRun.result_summary
  external_publish_requested = $false
} | ConvertTo-Json -Depth 8
