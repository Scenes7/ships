#!/usr/bin/env bash
# Pulls the latest pushed code onto the running server and restarts it.
# Usage: AWS_REGION=us-east-1 deploy/update-server.sh
set -euo pipefail
STACK=${STACK:-tank-duel}
export AWS_REGION=${AWS_REGION:-us-east-1}

ID=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
CMD=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/tanks/app && sudo -u tanks git pull --ff-only && cd server && sudo -u tanks npm ci --omit=dev && systemctl restart tanks"]' \
  --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID" || true
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
  --query '[Status, StandardOutputContent, StandardErrorContent]' --output text
