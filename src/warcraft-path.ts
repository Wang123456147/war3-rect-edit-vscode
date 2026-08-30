import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REGISTRY_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$locations = @(
  @{ Key = 'HKEY_CURRENT_USER\Software\Blizzard Entertainment\Warcraft III'; Name = 'InstallPath' },
  @{ Key = 'HKEY_CURRENT_USER\Software\Blizzard Entertainment\Warcraft III'; Name = 'GamePath' },
  @{ Key = 'HKEY_LOCAL_MACHINE\SOFTWARE\Blizzard Entertainment\Warcraft III'; Name = 'InstallPath' },
  @{ Key = 'HKEY_LOCAL_MACHINE\SOFTWARE\Blizzard Entertainment\Warcraft III'; Name = 'GamePath' },
  @{ Key = 'HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Blizzard Entertainment\Warcraft III'; Name = 'InstallPath' },
  @{ Key = 'HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Blizzard Entertainment\Warcraft III'; Name = 'GamePath' }
)
foreach ($location in $locations) {
  try {
    $value = [Microsoft.Win32.Registry]::GetValue($location.Key, $location.Name, $null)
    if ($null -ne $value -and [string]$value -ne '') {
      [Console]::Out.WriteLine([string]$value)
    }
  } catch {}
}
`;

export async function resolveWarcraftPath(configuredPath: string): Promise<string> {
  const configured = configuredPath.trim();
  if (configured.length > 0) {
    return configured;
  }
  return await readWarcraftPathFromRegistry() ?? '';
}

async function readWarcraftPathFromRegistry(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }
  try {
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', REGISTRY_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 }
    );
    for (const line of String(result.stdout).split(/\r?\n/)) {
      const candidate = registryValueToDirectory(line.trim());
      if (candidate !== undefined && await isDirectory(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Missing or inaccessible registry entries simply leave the path unset.
  }
  return undefined;
}

function registryValueToDirectory(value: string): string | undefined {
  if (value.length === 0) {
    return undefined;
  }
  const unquoted = value.replace(/^"|"$/g, '');
  return /\.(?:exe|app)$/i.test(unquoted) ? path.dirname(unquoted) : unquoted;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}
