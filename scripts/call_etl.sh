#!/bin/bash
API_BASE=${API_BASE:-$1}
ETL_SECRET=${ETL_SECRET:-$2}
if [ -z "$API_BASE" ] || [ -z "$ETL_SECRET" ]; then
  echo "Usage: ./scripts/call_etl.sh <API_BASE_URL> <ETL_SECRET>"
  exit 1
fi
curl -H "x-etl-secret: $ETL_SECRET" "$API_BASE/api/run-etl"
echo
