#!/bin/bash
# Random Proverbs verse

CHAPTERS=(1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31)
MAX_VERSES=(33 22 35 27 23 35 27 36 18 32 31 28 25 35 33 33 28 24 29 30 31 29 35 34 28 28 27 28 27 31 31)

CH=${CHAPTERS[$((RANDOM % 31))]}
MAX=${MAX_VERSES[$((CH-1))]}
VS=$((RANDOM % MAX + 1))

RESULT=$(curl -s "https://bible-api.com/proverbs+${CH}:${VS}")
REF=$(echo "$RESULT" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('reference','?'))")
TEXT=$(echo "$RESULT" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('text','Error fetching verse.').strip())")

echo "📖 $REF"
echo ""
echo "\"$TEXT\""
