# Run every check
$ErrorActionPreference = "Stop"
node build-router.mjs | Out-Null
node test-model-routing-config.mjs | Select-String "passed"
node test-router-host.mjs | Select-String "passed"
