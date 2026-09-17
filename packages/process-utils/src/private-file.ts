import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const PRIVATE_FILE_MAX_BYTES = 16_384;

const windowsAclValidation = `
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
function Assert-PrivateAcl($acl) {
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Private file has a different owner.' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'Private file grants another identity access.' }
  }
}
`;

async function executeWindowsPrivateFileScript(
  filePath: string,
  script: string,
  input?: string,
): Promise<string> {
  if (!isAbsolute(filePath))
    throw new Error("Private file path must be absolute.");
  const execution = execute(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "Text",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, ARC_PRIVATE_FILE: filePath },
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: PRIVATE_FILE_MAX_BYTES,
      encoding: "utf8",
    },
  );
  if (input !== undefined) {
    execution.child.stdin?.on("error", () => {});
    execution.child.stdin?.end(input, "utf8");
  }
  const { stdout } = await execution;
  return stdout;
}

async function windowsPermissions(
  filePath: string,
  protect: boolean,
): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([IO.File]::GetAttributes($env:ARC_PRIVATE_FILE) -band [IO.FileAttributes]::ReparsePoint) { throw 'Private file is a reparse point.' }
${windowsAclValidation}
$acl = [IO.File]::GetAccessControl($env:ARC_PRIVATE_FILE)
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Private file has a different owner.' }
if ($${protect ? "true" : "false"}) {
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($identity in $allowed) {
    $principal = [Security.Principal.SecurityIdentifier]::new($identity)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.File]::SetAccessControl($env:ARC_PRIVATE_FILE, $acl)
  $acl = [IO.File]::GetAccessControl($env:ARC_PRIVATE_FILE)
}
Assert-PrivateAcl $acl
`;
  await executeWindowsPrivateFileScript(filePath, script);
}

export async function protectPrivateFile(filePath: string): Promise<void> {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("Private file must be a regular file.");
  if (process.platform === "win32") await windowsPermissions(filePath, true);
  else await chmod(filePath, 0o600);
}

export async function verifyPrivateFilePermissions(
  filePath: string,
): Promise<void> {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("Private file must be a regular file.");
  if (process.platform === "win32") await windowsPermissions(filePath, false);
  else if (
    (details.mode & 0o077) !== 0 ||
    (process.getuid && details.uid !== process.getuid())
  ) {
    throw new Error("Private file has unsafe permissions.");
  }
}

export async function readPrivateFileUtf8(filePath: string): Promise<string> {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("Private file must be a regular file.");
  if (process.platform === "win32") {
    try {
      return await executeWindowsPrivateFileScript(
        filePath,
        `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$encoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $encoding
${windowsAclValidation}
$stream = [IO.File]::Open($env:ARC_PRIVATE_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$reader = $null
try {
  if (-not $stream.CanSeek -or $stream.Length -gt ${PRIVATE_FILE_MAX_BYTES}) { throw 'Private file exceeds the size limit or is not seekable.' }
  if ([IO.File]::GetAttributes($env:ARC_PRIVATE_FILE) -band [IO.FileAttributes]::ReparsePoint) { throw 'Private file is a reparse point.' }
  Assert-PrivateAcl ($stream.GetAccessControl())
  $reader = [IO.StreamReader]::new($stream, $encoding, $false, 4096, $true)
  $text = $reader.ReadToEnd()
} finally {
  if ($null -ne $reader) { $reader.Dispose() }
  $stream.Dispose()
}

[Console]::Write($text)
`,
      );
    } catch {
      throw new Error("Private file could not be read securely.");
    }
  }
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > PRIVATE_FILE_MAX_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error("Private file has unsafe permissions or size.");
    const bytes = Buffer.alloc(PRIVATE_FILE_MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > PRIVATE_FILE_MAX_BYTES)
      throw new Error("Private file exceeds the size limit.");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, count),
    );
  } finally {
    await file.close();
  }
}

export async function writePrivateFileUtf8(
  filePath: string,
  text: string,
): Promise<void> {
  if (/[\uD800-\uDFFF]/u.test(text))
    throw new Error("Private file content must be valid Unicode.");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > PRIVATE_FILE_MAX_BYTES)
    throw new Error("Private file exceeds the size limit.");
  if (process.platform === "win32") {
    try {
      await executeWindowsPrivateFileScript(
        filePath,
        `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$encoding = [Text.UTF8Encoding]::new($false, $true)
${windowsAclValidation}
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in $allowed) {
  $principal = [Security.Principal.SecurityIdentifier]::new($identity)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
}
$stream = [IO.FileStream]::new($env:ARC_PRIVATE_FILE, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $acl)
try {
  Assert-PrivateAcl ($stream.GetAccessControl())
  $inputStream = [Console]::OpenStandardInput()
  $bytes = [byte[]]::new(${PRIVATE_FILE_MAX_BYTES + 1})
  $count = 0
  while ($count -lt $bytes.Length) {
    $read = $inputStream.Read($bytes, $count, $bytes.Length - $count)
    if ($read -eq 0) { break }
    $count += $read
  }
  if ($count -gt ${PRIVATE_FILE_MAX_BYTES}) { throw 'Private file exceeds the size limit.' }
  [void]$encoding.GetString($bytes, 0, $count)
  $stream.Write($bytes, 0, $count)
  $stream.Flush($true)
} finally {
  $stream.Dispose()
}
`,
        text,
      );
    } catch {
      throw new Error("Private file could not be created securely.");
    }
    return;
  }
  const file = await open(filePath, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
