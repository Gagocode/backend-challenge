#!/bin/sh
set -eu

main_queue="${SQS_MAIN_QUEUE:-wager-transactions.fifo}"
output_queue="${SQS_OUTPUT_QUEUE:-wager-integration-events.fifo}"
dlq_queue="${SQS_DLQ:-wager-transactions-dlq.fifo}"

queue_url() {
  awslocal sqs get-queue-url \
    --queue-name "$1" \
    --query QueueUrl \
    --output text 2>/dev/null || true
}

ensure_fifo_queue() {
  name="$1"
  create_attributes="$2"
  update_attributes="$3"
  url="$(queue_url "${name}")"

  if [ -z "${url}" ] || [ "${url}" = "None" ]; then
    url="$(awslocal sqs create-queue \
      --queue-name "${name}" \
      --attributes "${create_attributes}" \
      --query QueueUrl \
      --output text)"
  else
    fifo="$(awslocal sqs get-queue-attributes \
      --queue-url "${url}" \
      --attribute-names FifoQueue \
      --query 'Attributes.FifoQueue' \
      --output text)"
    if [ "${fifo}" != "true" ]; then
      echo "Queue ${name} exists but is not FIFO; refusing to replace it" >&2
      exit 1
    fi
    awslocal sqs set-queue-attributes \
      --queue-url "${url}" \
      --attributes "${update_attributes}" \
      >/dev/null
  fi

  printf '%s' "${url}"
}

echo "Ensuring FIFO queues: ${main_queue}, ${output_queue} and ${dlq_queue}"

dlq_url="$(ensure_fifo_queue \
  "${dlq_queue}" \
  '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  '{"ContentBasedDeduplication":"false"}')"

dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "${dlq_url}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

main_queue_attributes="{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
main_queue_update_attributes="{\"ContentBasedDeduplication\":\"false\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

main_url="$(ensure_fifo_queue \
  "${main_queue}" \
  "${main_queue_attributes}" \
  "${main_queue_update_attributes}")"
main_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "${main_url}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

awslocal sqs set-queue-attributes \
  --queue-url "${dlq_url}" \
  --attributes "{\"RedriveAllowPolicy\":\"{\\\"redrivePermission\\\":\\\"byQueue\\\",\\\"sourceQueueArns\\\":[\\\"${main_arn}\\\"]}\"}" \
  >/dev/null

ensure_fifo_queue \
  "${output_queue}" \
  '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  '{"ContentBasedDeduplication":"false"}' \
  >/dev/null

echo "SQS FIFO queues are ready"
