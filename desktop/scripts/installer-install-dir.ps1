param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Validate', 'RemoveGhostShortcuts', 'GrantRuntimeAccess')]
    [string] $Mode,
    [Parameter(Mandatory = $true)]
    [string] $InstallDir,
    [string] $ExpectedExecutablePath = '',
    [string] $ShortcutPath1 = '',
    [string] $ShortcutPath2 = ''
)

$ErrorActionPreference = 'Stop'

function ConvertTo-NormalizedFullPath([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $fullPath = [System.IO.Path]::GetFullPath($Value.Trim())
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    while (
        $fullPath.Length -gt $root.Length -and
        ($fullPath.EndsWith('\') -or $fullPath.EndsWith('/'))
    ) {
        $fullPath = $fullPath.Substring(0, $fullPath.Length - 1)
    }
    return $fullPath
}

function Test-InstallDirectory {
    $createdDirectories = New-Object 'System.Collections.Generic.List[string]'
    $probePath = $null
    $stream = $null

    try {
        if ([string]::IsNullOrWhiteSpace($InstallDir)) {
            throw 'InstallDir is required'
        }

        $targetPath = ConvertTo-NormalizedFullPath $InstallDir
        $rootPath = [System.IO.Path]::GetPathRoot($targetPath)
        if ([string]::IsNullOrWhiteSpace($rootPath) -or -not [System.IO.Directory]::Exists($rootPath)) {
            throw "Install directory root does not exist: $rootPath"
        }
        if ([System.IO.File]::Exists($targetPath)) {
            throw "Install directory is a file: $targetPath"
        }

        $missingDirectories = New-Object 'System.Collections.Generic.List[string]'
        $currentPath = $targetPath
        while (-not [System.IO.Directory]::Exists($currentPath)) {
            if ([System.IO.File]::Exists($currentPath)) {
                throw "A parent path is a file: $currentPath"
            }
            $missingDirectories.Add($currentPath)
            $parent = [System.IO.Directory]::GetParent($currentPath)
            if ($null -eq $parent) {
                throw "Cannot resolve install directory parent: $currentPath"
            }
            $currentPath = $parent.FullName
        }

        for ($index = $missingDirectories.Count - 1; $index -ge 0; $index--) {
            $directory = $missingDirectories[$index]
            [System.IO.Directory]::CreateDirectory($directory) | Out-Null
            $createdDirectories.Add($directory)
        }

        $probePath = Join-Path $targetPath (
            '.wda-install-write-test-' + [System.Guid]::NewGuid().ToString('N') + '.tmp'
        )
        $stream = New-Object System.IO.FileStream(
            $probePath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough
        )
        $stream.WriteByte(0)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [System.IO.File]::Delete($probePath)
        $probePath = $null
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ($null -ne $probePath -and [System.IO.File]::Exists($probePath)) {
            [System.IO.File]::Delete($probePath)
        }

        for ($index = $createdDirectories.Count - 1; $index -ge 0; $index--) {
            $directory = $createdDirectories[$index]
            if (-not [System.IO.Directory]::Exists($directory)) {
                continue
            }
            $entries = [System.IO.Directory]::EnumerateFileSystemEntries($directory).GetEnumerator()
            try {
                if (-not $entries.MoveNext()) {
                    [System.IO.Directory]::Delete($directory, $false)
                }
            } finally {
                if ($entries -is [System.IDisposable]) {
                    $entries.Dispose()
                }
            }
        }
    }
}

function Grant-RuntimeAccess {
    $targetPath = ConvertTo-NormalizedFullPath $InstallDir
    if ([string]::IsNullOrWhiteSpace($targetPath)) {
        throw 'InstallDir is required'
    }
    $rootPath = [System.IO.Path]::GetPathRoot($targetPath)
    if ([string]::Equals($targetPath, $rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Runtime access cannot be granted to a filesystem root'
    }
    $root = New-Object System.IO.DirectoryInfo($targetPath)
    if (-not $root.Exists) {
        throw "Install directory does not exist: $targetPath"
    }
    if ($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Runtime directory contains a reparse point: $targetPath"
    }

    # Inspect each directory before entering it, so a legacy output junction
    # cannot expose user data through inherited application-package permissions.
    $pending = New-Object 'System.Collections.Generic.Queue[System.IO.DirectoryInfo]'
    $pending.Enqueue($root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        foreach ($entry in $directory.EnumerateFileSystemInfos()) {
            if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Runtime directory contains a reparse point: $($entry.FullName)"
            }
            if ($entry.Attributes -band [System.IO.FileAttributes]::Directory) {
                $pending.Enqueue($entry)
            }
        }
    }
    foreach ($relativePath in @('resources\app.asar', 'resources\backend\wechat-backend.exe')) {
        if (-not [System.IO.File]::Exists((Join-Path $targetPath $relativePath))) {
            throw "Missing packaged runtime file: $relativePath"
        }
    }

    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    $result = & $icacls $targetPath /grant '*S-1-15-2-2:(OI)(CI)(RX)' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Cannot grant sandbox runtime access: $($result -join [Environment]::NewLine)"
    }
}

function Remove-GhostInstallShortcuts {
    if ([string]::IsNullOrWhiteSpace($ExpectedExecutablePath)) {
        throw 'ExpectedExecutablePath is required'
    }

    $expectedTarget = ConvertTo-NormalizedFullPath $ExpectedExecutablePath
    foreach ($shortcutPath in @($ShortcutPath1, $ShortcutPath2) | Select-Object -Unique) {
        if ([string]::IsNullOrWhiteSpace($shortcutPath) -or -not [System.IO.File]::Exists($shortcutPath)) {
            continue
        }

        $shell = $null
        $shortcut = $null
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($shortcutPath)
            $actualTarget = ConvertTo-NormalizedFullPath ([string] $shortcut.TargetPath)
            if ([string]::Equals(
                $actualTarget,
                $expectedTarget,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                [System.IO.File]::Delete($shortcutPath)
            }
        } finally {
            if ($null -ne $shortcut -and [System.Runtime.InteropServices.Marshal]::IsComObject($shortcut)) {
                [void] [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
            }
            if ($null -ne $shell -and [System.Runtime.InteropServices.Marshal]::IsComObject($shell)) {
                [void] [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
            }
        }
    }
}

try {
    switch ($Mode) {
        'Validate' { Test-InstallDirectory }
        'RemoveGhostShortcuts' { Remove-GhostInstallShortcuts }
        'GrantRuntimeAccess' { Grant-RuntimeAccess }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

exit 0
