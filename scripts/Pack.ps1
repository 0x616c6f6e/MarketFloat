param(
    [string]$RuntimeZip,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json
$electronVersion = $manifest.devDependencies.electron
if ($electronVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Pin Electron to an exact stable version.' }
$runtimeName = "electron-v$electronVersion-win32-x64.zip"
$checksum = ((Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'electron-runtime.sha256')).Trim() -split '\s+')
if ($checksum.Count -ne 2 -or $checksum[0] -notmatch '^[a-f0-9]{64}$' -or $checksum[1] -cne $runtimeName) {
    throw "Update scripts/electron-runtime.sha256 for $runtimeName."
}
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a stable version in package.json.' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root 'dist' }
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$stage = Join-Path $root ('.package-' + [guid]::NewGuid().ToString('N'))
$bundle = Join-Path $stage 'MarketFloat'
$archiveName = "MarketFloat-$($manifest.version)-win-x64.zip"

Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Path $bundle | Out-Null
try {
    if ($RuntimeZip) {
        $runtime = (Resolve-Path -LiteralPath $RuntimeZip).Path
    } else {
        $runtime = Join-Path $stage $runtimeName
        $url = "https://github.com/electron/electron/releases/download/v$electronVersion/$runtimeName"
        & curl.exe --fail --location --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 --output $runtime $url
        if ($LASTEXITCODE) { throw 'Could not download the Electron runtime.' }
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $runtime).Hash -ine $checksum[0]) {
        throw "SHA-256 mismatch for $runtimeName."
    }

    $archive = [IO.Compression.ZipFile]::OpenRead($runtime)
    try {
        foreach ($entry in $archive.Entries) {
            if (!$entry.Name) { continue }
            $name = if ($entry.FullName -eq 'electron.exe') { 'MarketFloat.exe' } else { $entry.FullName }
            $destination = Join-Path $bundle $name
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination)
        }
    } finally {
        $archive.Dispose()
    }

    $resources = Join-Path $bundle 'resources\app'
    New-Item -ItemType Directory -Path $resources | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $resources
    Copy-Item -LiteralPath (Join-Path $root 'app') -Destination $resources -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $bundle
    $packedZip = Join-Path $stage $archiveName
    & tar.exe -a -cf $packedZip -C $stage 'MarketFloat'
    if ($LASTEXITCODE) { throw 'Could not write the Windows ZIP.' }

    $archive = [IO.Compression.ZipFile]::OpenRead($packedZip)
    try {
        $required = 'MarketFloat.exe', 'LICENSES.chromium.html', 'resources/app/package.json', "resources/app/$($manifest.main)"
        $required += Get-ChildItem -LiteralPath (Join-Path $root 'app') -File | ForEach-Object { 'resources/app/app/' + $_.Name }
        foreach ($name in $required) {
            if (!$archive.GetEntry("MarketFloat/$name")) { throw "Missing $name in the Windows ZIP." }
        }
    } finally {
        $archive.Dispose()
    }
    [IO.Directory]::CreateDirectory($output) | Out-Null
    $destination = Join-Path $output $archiveName
    Copy-Item -LiteralPath $packedZip -Destination $destination -Force
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), "$hash  $archiveName`n", [Text.Encoding]::ASCII)
    Write-Output $destination
} finally {
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    if ((Split-Path -Parent $resolvedStage) -eq $root -and (Split-Path -Leaf $resolvedStage) -match '^\.package-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
