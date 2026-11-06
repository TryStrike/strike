#!/usr/bin/env bash
# The one pre-deploy gate. It runs only here, never on GitHub Actions. The pre-push
# hook (.strike/pre-push) runs the parts a push touches.
#   .strike/check.sh backend | frontend | deploy | all
set -euo pipefail
cd "$(dirname "$0")/.."

backend() {
  local m=(--manifest-path backend/Cargo.toml)
  cargo fmt "${m[@]}" --all -- --check
  cargo clippy "${m[@]}" --workspace --all-targets -- -D warnings
  cargo test --locked "${m[@]}" --workspace
}

frontend() {
  cd frontend
  npx tsc --noEmit
  npx tsx lib/markets/bandCeiling.check.ts
  npx tsx lib/game/resultGroups.check.ts
  BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:8080}" npm run build
}

deploy() {
  for f in .strike/commit-msg .strike/pre-push .strike/check.sh backend/deploy/*.sh; do bash -n "$f"; done
  ruby -ryaml -e 'ARGV.each { |f| YAML.load_file(f) }' .github/workflows/*.yml
}

case "${1:-all}" in
  backend) backend ;;
  frontend) frontend ;;
  deploy) deploy ;;
  all) deploy && backend && frontend ;;
  *) echo "usage: .strike/check.sh backend|frontend|deploy|all" >&2; exit 2 ;;
esac
