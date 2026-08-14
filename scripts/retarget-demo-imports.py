#!/usr/bin/env python3
"""Point runMinimalSlice imports at vertical-slice-demo.js (NOT PRODUCTION)."""
import re

files = [
    "test/context-bounded.test.ts",
    "test/m0m1-parity-golden.test.ts",
    "test/opencode-go-provider.test.ts",
    "test/r1-exit-gates.test.ts",
    "test/r2-identity-rollover.test.ts",
    "test/rollover.test.ts",
    "test/vertical-slice.test.ts",
    "scripts/crash-worker.ts",
]

for path in files:
    src = open(path).read()
    changed = False
    # Remove runMinimalSlice from any vertical-slice.js import block
    # 1. Single-line import containing runMinimalSlice
    new = re.sub(
        r"import\s*\{\s*runMinimalSlice\s*,\s*([^}]*?)\s*\}\s*from\s*\"[^\"]*vertical-slice\.js\";",
        r"import { \1 } from \"../src/runtime/vertical-slice.js\";",
        src,
    )
    # 2. Multi-line: remove the runMinimalSlice line from the block
    new = re.sub(
        r"(\n[ \t]*)(runMinimalSlice,)(\n)",
        r"\1\3",
        new,
    )
    new = re.sub(
        r"import\s*\{\n([^}]*?)\n\}\s*from\s*\"[^\"]*vertical-slice\.js\";",
        lambda m: f"import {{\n{m.group(1)}\n}} from \"../src/runtime/vertical-slice.js\";",
        new,
    )
    if "vertical-slice-demo" not in new and "runMinimalSlice" in new:
        # Add a demo import after the first vertical-slice.js import
        new = new.replace(
            '"../src/runtime/vertical-slice.js";',
            '"../src/runtime/vertical-slice.js";\nimport { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";',
            1,
        )
        changed = True
    if new != src:
        open(path, "w").write(new)
        print("updated", path)
    else:
        print("unchanged", path)
