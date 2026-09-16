# Rebuild and run every offline suite.
#
# Kept next to the node runner because a Windows checkout often starts with
# PowerShell: same work, same verdict.
$ErrorActionPreference = "Stop"
node build-router.mjs
node run-tests.mjs
