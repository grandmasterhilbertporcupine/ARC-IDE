param([Parameter(Mandatory = $true)][string]$AppGuid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$installations = [System.Collections.Generic.List[object]]::new()
$uninstallEntries = [System.Collections.Generic.List[object]]::new()
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      $install = $base.OpenSubKey("Software\$AppGuid")
      if ($null -ne $install) {
        try { $installations.Add(@{ hive = $hive.ToString(); view = $view.ToString(); key = $AppGuid; location = [string]$install.GetValue('InstallLocation', '') }) }
        finally { $install.Dispose() }
      }
      $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
      if ($null -ne $uninstall) {
        try {
          foreach ($name in $uninstall.GetSubKeyNames()) {
            $entry = $uninstall.OpenSubKey($name)
            if ($null -eq $entry) { continue }
            try {
              $displayName = [string]$entry.GetValue('DisplayName', '')
              if ($name -eq $AppGuid) {
                $uninstallEntries.Add(@{ hive = $hive.ToString(); view = $view.ToString(); key = $name; displayName = $displayName })
              }
            } finally { $entry.Dispose() }
          }
        } finally { $uninstall.Dispose() }
      }
    } finally { $base.Dispose() }
  }
}
$shortcuts = [System.Collections.Generic.List[object]]::new()
$shell = New-Object -ComObject Shell.Application
try {
  foreach ($folder in @('DesktopDirectory', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms')) {
    $directory = [Environment]::GetFolderPath($folder)
    foreach ($name in @('ARC IDE.lnk', 'ARC IDE')) {
      $candidate = Join-Path $directory $name
      if (Test-Path -LiteralPath $candidate) {
        $target = ''
        if ($name.EndsWith('.lnk')) {
          $namespace = $shell.NameSpace($directory)
          $item = $namespace.ParseName($name)
          $link = $item.GetLink
          try { $target = [string]$link.Path }
          finally {
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($namespace)
          }
        }
        $shortcuts.Add(@{ path = $candidate; target = $target })
      }
    }
  }
} finally { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
$processes = @(Get-Process -Name 'ARC IDE' -ErrorAction SilentlyContinue | ForEach-Object { @{ id = $_.Id; name = $_.ProcessName; executablePath = $_.Path } })
$profiles = @(
  (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'ARC'),
  (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.arc'),
  (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'WNDR'),
  (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.wndr'),
  (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'bb'),
  (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.bb')
)
@{ installations = @($installations.ToArray()); uninstallEntries = @($uninstallEntries.ToArray()); shortcuts = @($shortcuts.ToArray()); processes = $processes; profiles = $profiles } | ConvertTo-Json -Depth 6 -Compress
