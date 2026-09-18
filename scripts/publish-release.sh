#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?}" "${RELEASE_TAG:?}" "${VERSION:?}" "${PRERELEASE:?}" "${DMG_NAME:?}" "${RUNNER_TEMP:?}" "${GITHUB_STEP_SUMMARY:?}"

zip_name="${DMG_NAME%.dmg}.zip"
assets=(
  "dist/$DMG_NAME"
  "dist/$zip_name"
  "dist/${zip_name}.blockmap"
  "dist/latest-mac.yml"
  "dist/SHA256SUMS.txt"
)

# A published version is immutable, including when a workflow is re-run.
gh api --paginate "repos/$GH_REPO/releases" > "$RUNNER_TEMP/pigui-releases.json"
existing=$(jq -r --arg tag "$RELEASE_TAG" '.[] | select(.tag_name == $tag) | .draft' "$RUNNER_TEMP/pigui-releases.json")
if [[ "$existing" == false ]]; then
  echo '::error::This release is already published; create a new version instead.'
  exit 1
fi

missing=()
for asset in "${assets[@]}"; do
  if [[ ! -f "$asset" ]]; then
    missing+=("$asset")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "::error::Missing release assets: ${missing[*]}"
  exit 1
fi

if [[ "$existing" != true ]]; then
  # Create the draft without assets so the upload below is the same retried,
  # parallel path on the first publish and on re-runs alike.
  args=(--draft --verify-tag --title "Pace $VERSION" --generate-notes)
  if [[ "$PRERELEASE" == true ]]; then args+=(--prerelease); fi
  gh release create "$RELEASE_TAG" "${args[@]}"
fi

# Upload bandwidth is throttled per connection and a stalled transfer does not
# recover on its own, so each asset goes up in parallel with its own retries.
upload_asset() {
  local asset=$1
  for attempt in 1 2 3; do
    if gh release upload "$RELEASE_TAG" "$asset" --clobber; then
      return 0
    fi
    echo "::warning::Upload of $asset failed (attempt $attempt); retrying." >&2
  done
  return 1
}
pids=()
for asset in "${assets[@]}"; do
  upload_asset "$asset" &
  pids+=($!)
done
failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
if (( failed )); then
  echo '::error::At least one release asset failed to upload.'
  exit 1
fi

# Keep incomplete uploads private; only publish after every required asset is present.
latest=true
if [[ "$PRERELEASE" == true ]]; then latest=false; fi
gh release edit "$RELEASE_TAG" --draft=false --prerelease="$PRERELEASE" --latest="$latest"
gh release view "$RELEASE_TAG" --json url --jq '"Release: " + .url' >> "$GITHUB_STEP_SUMMARY"
