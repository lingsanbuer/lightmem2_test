#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
DEV_PLUGIN_PATH="${PLUGIN_DIR}"

if [[ -f "${CONFIG_PATH}" ]] && command -v jq >/dev/null 2>&1; then
  tmp_file="$(mktemp)"
  jq --arg dev_path "${DEV_PLUGIN_PATH}" '
    if .plugins.load.paths? then
      (.plugins.load.paths |= map(select(. != $dev_path))) |
      if ((.plugins.load.paths // []) | length) == 0 then
        del(.plugins.load)
      else
        .
      end
    else
      .
    end
  ' "${CONFIG_PATH}" > "${tmp_file}"
  if ! cmp -s "${tmp_file}" "${CONFIG_PATH}"; then
    cp "${CONFIG_PATH}" "${CONFIG_PATH}.bak.release-install"
    mv "${tmp_file}" "${CONFIG_PATH}"
  else
    rm -f "${tmp_file}"
  fi
fi

archive_path="$("${SCRIPT_DIR}/pack_release.sh")"

if openclaw plugins info ecoclaw >/dev/null 2>&1; then
  printf 'y\n' | openclaw plugins uninstall ecoclaw >/dev/null 2>&1 || true
fi

openclaw plugins install "${archive_path}"
openclaw gateway restart

printf 'Installed release plugin from %s\n' "${archive_path}"
