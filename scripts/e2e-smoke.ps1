$ErrorActionPreference = "Stop"
$repo = Join-Path $env:TEMP ("wsp-e2e-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path "$repo/packages/foo", "$repo/packages/lib", "$repo/packages/bar", "$repo/shared" | Out-Null
Set-Content "$repo/package.json" '{ "name":"root","private":true,"workspaces":["packages/*"] }'
Set-Content "$repo/packages/foo/package.json" '{ "name":"foo","version":"1.0.0","dependencies":{"lib":"^2.0.0","shared":"file:../../shared","is-number":"^7.0.0"},"devDependencies":{"is-odd":"^3.0.0"} }'
Set-Content "$repo/packages/foo/index.js" 'export const foo=1;'
Set-Content "$repo/packages/lib/package.json" '{ "name":"lib","version":"2.0.0","dependencies":{"is-number":"^7.0.0"} }'
Set-Content "$repo/packages/lib/index.js" 'export const lib=1;'
Set-Content "$repo/packages/bar/package.json" '{ "name":"bar","version":"1.0.0","dependencies":{"left-pad":"^1.3.0"} }'
Set-Content "$repo/shared/package.json" '{ "name":"shared","version":"3.0.0" }'
Set-Content "$repo/shared/index.js" 'export const shared=1;'
Push-Location $repo
npm install --no-audit --no-fund
Pop-Location
Write-Host "repo=$repo"
Write-Host "lockfile exists: $(Test-Path "$repo/package-lock.json")"
node q:\src\ws-pack\out\cli.js --target foo --repo $repo --staging "$repo/out" --install npm-install --archive tgz
Write-Host "---- staging node_modules ----"
Get-ChildItem "$repo/out/node_modules" | Select-Object -ExpandProperty Name
Write-Host "bar present:      $(Test-Path "$repo/out/node_modules/bar")"
Write-Host "left-pad present: $(Test-Path "$repo/out/node_modules/left-pad")"
Write-Host "lib present:      $(Test-Path "$repo/out/node_modules/lib")"
Write-Host "shared present:   $(Test-Path "$repo/out/node_modules/shared")"
Write-Host "is-number:        $(Test-Path "$repo/out/node_modules/is-number")"
Remove-Item -Recurse -Force $repo