#!/usr/bin/env bash

c=0

while IFS= read -r -d '' file; do
    bun test "$file" || c=$?
done < <(find tests -name '*.test.js' -print0)

exit $c
