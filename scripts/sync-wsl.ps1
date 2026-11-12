[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$Distro = 'OpenClawGateway',

    [ValidatePattern('^[A-Za-z0-9._/-]+$')]
    [string]$SourceRef = 'main'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$revision = (& git -C $repository rev-parse --verify "$SourceRef^{commit}" 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}$') {
    throw "Cannot resolve Git commit: $SourceRef"
}

$archive = [IO.Path]::GetTempFileName()
$remoteArchive = $null
try {
    # Revisions from before the LinkedIn renderer have no lockfile, and the archive must not name a missing path.
    $paths = @('package.json', 'config', 'scripts', 'systemd', 'test', 'linkedin', 'instagram')
    if (& git -C $repository ls-tree --name-only $revision package-lock.json) { $paths += 'package-lock.json' }
    & git -C $repository archive --format=tar "--output=$archive" $revision @paths
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Git archive.' }

    $remoteArchive = (& wsl.exe -d $Distro -u openclaw -- mktemp /tmp/social-openclaw-sync.XXXXXXXX 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $remoteArchive -notmatch '^/tmp/social-openclaw-sync\.[A-Za-z0-9]+$') {
        throw 'Could not create a private WSL transfer file.'
    }

    $encodedArchive = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archive))
    $decodeArchive = "set -euo pipefail; umask 077; tr -cd 'A-Za-z0-9+/=' | base64 -d > '$remoteArchive'; tar -tf '$remoteArchive' >/dev/null"
    $encodedArchive | & wsl.exe -d $Distro -u openclaw -- bash -c $decodeArchive
    if ($LASTEXITCODE -ne 0) { throw 'Could not transfer the Git archive to WSL.' }

    $hashStream = [IO.File]::OpenRead($archive)
    try {
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            $localHash = [BitConverter]::ToString($hasher.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant()
        } finally {
            $hasher.Dispose()
        }
    } finally {
        $hashStream.Dispose()
    }
    $remoteHash = ((& wsl.exe -d $Distro -u openclaw -- sha256sum $remoteArchive 2>&1 | Out-String).Trim() -split '\s+')[0]
    if ($LASTEXITCODE -ne 0 -or $remoteHash -ne $localHash) {
        throw 'The transferred Git archive failed SHA-256 verification.'
    }

    $apply = if ($PSCmdlet.ShouldProcess("${Distro}: social Gateway profile", "Synchronize Git revision $revision")) { '1' } else { '0' }

    $linuxScript = @'
set -euo pipefail
umask 077
archive='__ARCHIVE__'
revision='__REVISION__'
apply='__APPLY__'
node=/home/openclaw/.openclaw/tools/node/bin/node
profile_dir=/home/openclaw/.openclaw-social
install="$profile_dir/social-openclaw"
units="$HOME/.config/systemd/user"
dropin="$units/openclaw-gateway-social.service.d"
agents='linkedin instagram'

if [ "$(id -un)" != 'openclaw' ]; then
  echo 'Run this sync as the openclaw WSL user.' >&2
  exit 1
fi

stage=$(mktemp -d /tmp/social-openclaw-stage.XXXXXXXX)
cleanup() {
  case "$stage" in /tmp/social-openclaw-stage.*) rm -rf -- "$stage" ;; esac
}
trap cleanup EXIT
tar -xf "$archive" -C "$stage"
# These run by their own path (their shebang is the bundled Node), which is what the exec allowlist names.
chmod u+x "$stage/linkedin/publisher/publish.mjs" "$stage/linkedin/scripts/auth.mjs" "$stage/linkedin/scripts/store-client-secret.mjs" \
  "$stage/instagram/publisher/publish.mjs" "$stage/instagram/scripts/token.mjs" "$stage/instagram/scripts/b2.mjs"
# The renderers and the dependencies the lockfile pins (@resvg/resvg-js, jpeg-js), installed with no install scripts.
# Revisions from before a renderer do not have it.
if [ -e "$stage/linkedin/publisher/render.mjs" ]; then chmod u+x "$stage/linkedin/publisher/render.mjs"; fi
if [ -e "$stage/instagram/publisher/render.mjs" ]; then chmod u+x "$stage/instagram/publisher/render.mjs"; fi
if [ -f "$stage/package-lock.json" ]; then
  (cd "$stage" && "$node" "$(dirname "$node")/../lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --no-audit --no-fund)
fi

# The tests run before anything installed changes; a failure leaves the Gateway as it was.
echo "Source revision: $revision"
(cd "$stage" && "$node" --test)

for required in "$profile_dir/openclaw.json" "$units/openclaw-gateway-social.service"; do
  if [ ! -e "$required" ]; then
    echo "Missing $required: follow the Setup section of docs/operations.md first." >&2
    exit 1
  fi
done

backup="$profile_dir/sync-backups/$revision-$(date -u +%Y%m%dT%H%M%SZ)"
sync_path() {
  local source=$1 destination=$2 backup_part=$3
  shift 3
  if [ "$apply" = '1' ]; then
    mkdir -p -- "$backup/$backup_part" "$(dirname -- "$destination")"
    rsync -a --itemize-changes --checksum --backup --backup-dir="$backup/$backup_part" \
      --chmod=D700,Fu+rw,Fgo-rwx "$@" -- "$source" "$destination"
  else
    rsync -anc --itemize-changes --chmod=D700,Fu+rw,Fgo-rwx "$@" -- "$source" "$destination"
  fi
}
verify_path() {
  local source=$1 destination=$2 delta
  shift 2
  delta=$(rsync -rcn --out-format='%n' "$@" -- "$source" "$destination")
  if [ -n "$delta" ]; then
    echo "Content verification failed for $destination: $delta" >&2
    exit 1
  fi
}

if [ "$apply" = '0' ]; then echo 'Preview only; nothing installed will change.'; fi
# Each agent's runtime files (content/, state/) are never in Git and never touched; nothing is ever deleted.
for agent in $agents; do
  sync_path "$stage/$agent/workspace/" "$profile_dir/workspace-$agent/" "workspace-$agent" --exclude=/content/ --exclude=/state/
done
sync_path "$stage/" "$install/" install --exclude=/systemd/
dropin_before=$({ cat "$dropin/umask.conf" 2>/dev/null || true; } | sha256sum)
sync_path "$stage/systemd/openclaw-gateway-social.service.d/" "$dropin/" units

if [ "$apply" = '1' ]; then
  for agent in $agents; do
    verify_path "$stage/$agent/workspace/" "$profile_dir/workspace-$agent/" --exclude=/content/ --exclude=/state/
  done
  verify_path "$stage/" "$install/" --exclude=/systemd/
  verify_path "$stage/systemd/openclaw-gateway-social.service.d/" "$dropin/"
  echo "Previous versions: $backup"
  if [ "$dropin_before" != "$(sha256sum < "$dropin/umask.conf")" ]; then
    systemctl --user daemon-reload
    systemctl --user restart openclaw-gateway-social.service
    echo 'Restarted openclaw-gateway-social.service for its systemd drop-in.'
  fi
  "$node" "$install/scripts/apply-gateway.mjs" apply
else
  "$node" "$stage/scripts/apply-gateway.mjs" plan
fi
'@

    $linuxScript = $linuxScript.Replace('__ARCHIVE__', $remoteArchive).
        Replace('__REVISION__', $revision).
        Replace('__APPLY__', $apply)
    $linuxScript = $linuxScript.Replace("`r`n", "`n").Replace("`r", "`n")
    $encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($linuxScript))
    $encodedScript | & wsl.exe -d $Distro -u openclaw -- bash -c "set -o pipefail; tr -cd 'A-Za-z0-9+/=' | base64 -d | bash -l"
    if ($LASTEXITCODE -ne 0) { throw 'social Gateway deployment failed.' }
} finally {
    Remove-Item -LiteralPath $archive -Force -WhatIf:$false -ErrorAction SilentlyContinue
    if ($remoteArchive -match '^/tmp/social-openclaw-sync\.[A-Za-z0-9]+$') {
        & wsl.exe -d $Distro -u openclaw -- rm -f -- $remoteArchive | Out-Null
    }
}
