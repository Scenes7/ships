#!/usr/bin/env bash
# Creates/updates the AWS stack and points the client at the new server.
# Usage: AWS_REGION=us-east-1 deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
STACK=${STACK:-tank-duel}
export AWS_REGION=${AWS_REGION:-us-east-1}

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file deploy/server.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset

URL=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ServerUrl'].OutputValue" --output text)
sed -i.bak "s#^const PRODUCTION_SERVER = .*#const PRODUCTION_SERVER = '$URL';#" client/config.js && rm client/config.js.bak

echo "Server: $URL"
echo "Health: ${URL/wss:/https:}/  (allow ~2 minutes on first boot for setup + TLS certificate)"
echo "client/config.js updated - commit and push to publish the site."
