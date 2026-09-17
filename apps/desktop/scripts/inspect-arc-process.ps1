param([Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$arcProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if ($null -eq $arcProcess) {
  @{ exists = $false } | ConvertTo-Json -Compress
} else {
  @{ exists = $true; id = $arcProcess.Id; executablePath = $arcProcess.Path; startedAt = $arcProcess.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
}
