#!/bin/bash
set -euo pipefail

main_queue="${SQS_MAIN_QUEUE:-wager-transactions.fifo}"
output_queue="${SQS_OUTPUT_QUEUE:-wager-integration-events.fifo}"
dlq_queue="${SQS_DLQ:-wager-transactions-dlq.fifo}"

echo "Creating FIFO queues: ${main_queue}, ${output_queue} and ${dlq_queue}"

dlq_url="$(awslocal sqs create-queue \
  --queue-name "${dlq_queue}" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl \
  --output text)"

dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "${dlq_url}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

main_queue_attributes="$(cat <<EOF
{"FifoQueue":"true","ContentBasedDeduplication":"false","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"${dlq_arn}\\",\\"maxReceiveCount\\":\\"5\\"}"}
EOF
)"

awslocal sqs create-queue \
  --queue-name "${main_queue}" \
  --attributes "${main_queue_attributes}" \
  --query QueueUrl \
  --output text

awslocal sqs create-queue \
  --queue-name "${output_queue}" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl \
  --output text

echo "SQS FIFO queues are ready"
