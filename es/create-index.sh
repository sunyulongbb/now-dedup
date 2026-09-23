#!/bin/sh
set -eu

ES_URL="${ES_URL:-http://elasticsearch:9200}"
INDEX_NAME="${INDEX_NAME:-entity}"

if curl --fail --silent --head "${ES_URL}/${INDEX_NAME}" >/dev/null; then
  echo "Elasticsearch index '${INDEX_NAME}' already exists."
  exit 0
fi

echo "Creating Elasticsearch index '${INDEX_NAME}'..."
curl --fail-with-body --silent --show-error \
  --request PUT "${ES_URL}/${INDEX_NAME}" \
  --header "Content-Type: application/json" \
  --data-binary @/config/entity-index.json
echo
echo "Elasticsearch index '${INDEX_NAME}' is ready."
