<#
.SYNOPSIS
    Run the whole ADP test suite in a throwaway WSL distro, then destroy it.

.DESCRIPTION
    The question this answers: can a tester with a brand new Windows machine get
    from nothing to a full passing run, and back to nothing?

    Everything else in docs/test-environment-automation.md verifies pieces of
    that on machines which already have something installed. This verifies the
    whole claim, by creating a Linux system that has never seen this project,
    provisioning it with scripts/dev/bootstrap.sh, running the suite, and then
    unregistering the distro.

    The distro *is* the teardown guarantee. `make down` asserts no containers or
    processes leaked; this goes further and removes the filesystem they lived
    on, so "returned the machine to its prior state" is structural rather than a
    claim to be audited.

    Nothing is installed on Windows. The only requirement is WSL itself.

.PARAMETER RepoUrl
    Repository to clone. Defaults to the public ADP remote - cloning the remote
    is what a tester actually does, so it is the default rather than an option.

.PARAMETER Ref
    Branch, tag or commit to check out. Use this to exercise a pull request
    before merging it.

.PARAMETER Distro
    Base image, from `wsl --list --online`.

.PARAMETER SkipUi
    Skip the Playwright web UI steps. They add a Chromium download and its
    system libraries to a distro that is about to be deleted.

.PARAMETER KeepDistro
    Leave the distro registered on failure so it can be inspected. It is
    reported by name; remove it with `wsl --unregister <name>`.

.EXAMPLE
    .\Run-CleanTest.ps1
    Clone main into a fresh distro, run everything, destroy it.

.EXAMPLE
    .\Run-CleanTest.ps1 -Ref claude/phase3-acceptance -KeepDistro
    Test a branch and keep the distro if it fails.
#>
[CmdletBinding()]
param(
    [string] $RepoUrl = 'https://github.com/DeDuva/adp.git',
    [string] $Ref = 'main',
    [string] $Distro = 'Ubuntu-24.04',
    [switch] $SkipUi,
    [switch] $KeepDistro
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Keep this file ASCII-only. Windows PowerShell 5.1 - still the default on a new
# Windows machine, which is exactly the machine this script targets - reads a
# file with no byte-order mark as ANSI, not UTF-8. A single em dash in a comment
# therefore becomes mojibake that derails the parser, and the reported error
# points at an unrelated line further down. Written after doing exactly that.

# wsl.exe emits UTF-16LE for its own messages unless told otherwise, which turns
# every captured string into mojibake interleaved with nulls.
$env:WSL_UTF8 = '1'

$script:StartedAt = Get-Date
$script:DistroName = "adp-clean-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$script:DistroPath = Join-Path $env:LOCALAPPDATA "adp-clean-test\$script:DistroName"
$script:Registered = $false

function Write-Step { param([string] $Message)
    Write-Host ''
    Write-Host "== $Message ==" -ForegroundColor Cyan
}
function Write-Ok   { param([string] $Message) Write-Host "  ok    $Message" -ForegroundColor Green }
function Write-Info { param([string] $Message) Write-Host "  --    $Message" -ForegroundColor DarkGray }
function Write-Fail { param([string] $Message) Write-Host "  FAIL  $Message" -ForegroundColor Red }

# Run a command in the throwaway distro as root and throw on a non-zero exit.
# -lc so the profile is sourced: NodeSource puts node on PATH via /etc/profile.d
# and bootstrap.sh's work would otherwise be invisible to later commands.
function Invoke-InDistro {
    param(
        [Parameter(Mandatory)] [string] $Command,
        [string] $What = $Command
    )
    Write-Info $What
    # --cd / because wsl.exe otherwise tries to translate the *caller's* working
    # directory into the target distro. Run this script from a \\wsl.localhost\
    # path belonging to a different distro - which is exactly what happens when
    # the repo lives in another WSL distro - and every invocation emits
    # "Failed to translate ...". It falls back and still runs, so this is noise
    # rather than failure, but noise that looks like a fatal error in a log is
    # its own cost. Pinning the working directory also makes the `cd /opt/adp`
    # in each command the only thing that determines where it runs.
    & wsl.exe -d $script:DistroName --cd / -u root -- bash -lc $Command
    if ($LASTEXITCODE -ne 0) {
        throw "in-distro command failed (exit $LASTEXITCODE): $What"
    }
}

function Remove-Distro {
    if (-not $script:Registered) { return }
    Write-Step 'teardown'
    # --unregister deletes the VHD, so everything the run created - packages,
    # containers, images, the checkout - goes with it. There is nothing to
    # verify afterwards because there is nothing left.
    & wsl.exe --unregister $script:DistroName 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "unregistered $script:DistroName"
        $script:Registered = $false
    } else {
        Write-Fail "could not unregister $script:DistroName - remove it with: wsl --unregister $script:DistroName"
    }
    if (Test-Path $script:DistroPath) {
        Remove-Item -Recurse -Force $script:DistroPath -ErrorAction SilentlyContinue
        if (-not (Test-Path $script:DistroPath)) { Write-Ok "removed $script:DistroPath" }
    }
    # The parent too, but only when empty - it is a directory this script
    # created, so leaving it behind means a "clean" run still changed the
    # machine. Emptiness is the guard against deleting a concurrent run's work.
    $parent = Split-Path $script:DistroPath -Parent
    if ((Test-Path $parent) -and -not (Get-ChildItem -Force $parent)) {
        Remove-Item -Force $parent -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------

Write-Host 'ADP clean-room run' -ForegroundColor White
Write-Host "  distro   $script:DistroName"
Write-Host "  base     $Distro"
Write-Host "  repo     $RepoUrl @ $Ref"

Write-Step 'preflight'

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Fail 'WSL is not installed'
    Write-Host '        Install it (needs admin, and usually a reboot):  wsl --install'
    Write-Host '        This is the one manual step on a brand new machine.'
    exit 1
}

# `wsl --install --name` landed in 2.4.4. Older builds need a rootfs tarball and
# `wsl --import`, which is a different script; say so rather than failing later
# with something cryptic.
$versionLine = (& wsl.exe --version 2>$null | Select-String -Pattern 'WSL version:\s*([0-9.]+)')
if (-not $versionLine) {
    Write-Fail 'could not determine the WSL version (WSL 1, or a very old build)'
    Write-Host '        This script needs WSL 2.4.4+ for "wsl --install --name".'
    exit 1
}
$wslVersion = [version] $versionLine.Matches[0].Groups[1].Value
if ($wslVersion -lt [version] '2.4.4') {
    Write-Fail "WSL $wslVersion is too old - 2.4.4+ required for 'wsl --install --name'"
    Write-Host '        Update with:  wsl --update'
    exit 1
}
Write-Ok "WSL $wslVersion"

if (& wsl.exe -l -q 2>$null | Where-Object { $_.Trim() -eq $script:DistroName }) {
    Write-Fail "a distro named $script:DistroName already exists"
    exit 1
}
Write-Ok 'distro name is free'

# Pessimistic default: under StrictMode the finally block must find this set
# however the try exits, and "failed" is the safer thing to assume.
$failed = $true

try {
    Write-Step 'create the distro'
    New-Item -ItemType Directory -Force -Path $script:DistroPath | Out-Null
    # --no-launch: register it without the interactive first-run account setup.
    # Everything below runs as root, which is what a provisioning script wants
    # and what a fresh `wsl --import` would give anyway.
    & wsl.exe --install $Distro --name $script:DistroName --location $script:DistroPath --no-launch
    if ($LASTEXITCODE -ne 0) { throw "wsl --install failed (exit $LASTEXITCODE)" }
    $script:Registered = $true
    Write-Ok "created $script:DistroName at $script:DistroPath"

    Write-Step 'clone'
    # The irreducible pre-clone minimum: you cannot check out a repo without
    # git. Keeping this to exactly these packages is what stops the script from
    # quietly provisioning the thing under test - everything else is
    # bootstrap.sh's job, and if it misses something, this run fails.
    Invoke-InDistro -What 'install git (the pre-clone minimum)' -Command @'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null
'@

    Invoke-InDistro -What "clone $RepoUrl @ $Ref" -Command @"
set -e
git clone --quiet '$RepoUrl' /opt/adp
cd /opt/adp
git checkout --quiet '$Ref'
git log --oneline -1
"@

    Write-Step 'provision'
    Invoke-InDistro -What 'bootstrap.sh' -Command 'cd /opt/adp && bash scripts/dev/bootstrap.sh'

    Write-Step 'run the suite'
    Invoke-InDistro -What 'make doctor' -Command 'cd /opt/adp && make doctor'
    Invoke-InDistro -What 'make up' -Command 'cd /opt/adp && make up'
    Invoke-InDistro -What 'make test-all' -Command 'cd /opt/adp && make test-all'

    if ($SkipUi) {
        Write-Info 'web UI steps skipped (-SkipUi)'
    } else {
        Invoke-InDistro -What 'chromium system libraries' `
            -Command 'cd /opt/adp && npx --prefix server playwright install-deps chromium'
        Invoke-InDistro -What 'make acceptance-ui' -Command 'cd /opt/adp && make acceptance-ui'
    }

    # Belt and braces: `make down` asserts the machine is clean, and then the
    # distro is deleted anyway. The assertion still matters - it is the same
    # teardown a developer runs, so a leak regression should fail here too
    # rather than being hidden by the unregister that follows.
    Invoke-InDistro -What 'make down' -Command 'cd /opt/adp && make down'

    $elapsed = (Get-Date) - $script:StartedAt
    Write-Host ''
    Write-Host ("== clean room passed in {0:mm}m{0:ss}s ==" -f $elapsed) -ForegroundColor Green
    $failed = $false
}
catch {
    Write-Host ''
    Write-Fail $_.Exception.Message
    $failed = $true
}
finally {
    if ($failed -and $KeepDistro) {
        Write-Step 'teardown'
        Write-Info "kept $script:DistroName for inspection (-KeepDistro)"
        Write-Info "  enter it:  wsl -d $script:DistroName -u root"
        Write-Info "  remove it: wsl --unregister $script:DistroName"
    } else {
        Remove-Distro
    }
}

if ($failed) { exit 1 }
exit 0
