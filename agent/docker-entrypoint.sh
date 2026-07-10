#!/bin/sh
set -eu

# Prepare dynamic-service state only for the long-lived daemon command. Other
# commands (`status`, `test`, explicit legacy `enroll`, etc.) remain unchanged.
if [ "${1:-run}" = "run" ] && [ -n "${FINCH_APP_PATH:-}" ]; then
  case "$FINCH_APP_PATH" in
    *[!a-z0-9-]*|'')
      echo "finch: FINCH_APP_PATH must already be a lowercase service slug" >&2
      exit 2
      ;;
  esac

  credential_dir=${FINCH_CREDENTIALS_DIR:-/data/.finch}
  credential="$credential_dir/$FINCH_APP_PATH.json"

  umask 077
  mkdir -p "$credential_dir"

  if [ ! -s "$credential" ]; then
    # AviaryMCP's default first-run path is intentionally credentialless:
    # finchd must bring up its local control socket so the SDK can register a
    # needs_enrollment lease and start the manifest-bound browser device flow.
    # Legacy ticket credentials are deliberately not bootstrapped here because
    # they carry no approved routes/edge_auth policy.
    echo "finch: no credential for $FINCH_APP_PATH; starting control plane for device enrollment" >&2
  fi
fi

exec finch "$@"
