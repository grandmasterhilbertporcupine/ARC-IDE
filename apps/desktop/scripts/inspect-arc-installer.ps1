param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$item = Get-Item -LiteralPath $Installer
if ($item.PSIsContainer -or $item.Extension -ne '.exe') { throw 'Installer must be an executable file.' }
$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName)
$signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
@{ product = $info.ProductName; version = $info.ProductVersion; fileVersion = $info.FileVersion; signatureStatus = $signature.Status.ToString(); signerThumbprint = $signature.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress
