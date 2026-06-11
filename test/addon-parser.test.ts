/**
 * Tests for add-on parsing logic.
 *
 * Covers:
 *   - parseAddonsFromSellerNote (booking-parser.ts)
 *
 * Run with:
 *   npx tsx test/addon-parser.test.ts
 */

import { parseAddonsFromSellerNote } from '../lib/square/booking-parser';

let passed = 0;
let failed = 0;

function assert(description: string, actual: string[], expected: string[]) {
  const ok =
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i]);
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('\n🧪 Add-on Parser Tests\n');

// ─── Group 1: Website booking formats ────────────────────────────────────────
console.log('Group 1: Website booking formats');

// Test 1 – No add-ons in notes
assert(
  'Test 1: Website booking with no add-ons',
  parseAddonsFromSellerNote('Vehicle: sedan'),
  []
);

// Test 2 – One structured add-on (current Square format)
assert(
  'Test 2: Website booking with one structured add-on',
  parseAddonsFromSellerNote(
    'ADD-ONS (customer selected):\n• Odor Eliminator'
  ),
  ['Odor Eliminator']
);

// Test 3 – Two structured add-ons (actual Taylor Hopper format)
assert(
  'Test 3: Website booking with two structured add-ons',
  parseAddonsFromSellerNote(
    '🔒 CARD ON FILE: ccofCA4SEFbvniGHT18nCzE3WU5ciuMoAg\n' +
    '($20 no-show/late-cancel protection) ADD-ONS (customer selected):\n' +
    '• Odor Eliminator\n' +
    '• Disinfectant Service\n' +
    'Pricing note:\n' +
    'Add-ons not charged today. Collect add-on payment at service time.'
  ),
  ['Odor Eliminator', 'Disinfectant Service']
);

// ─── Group 2: Square-only fallback (square notes) ─────────────────────────────
console.log('\nGroup 2: Square-only notes fallback');

// Test 4 – One add-on in Square notes (old REQUESTED format)
assert(
  'Test 4: Square-only booking with one add-on in notes',
  parseAddonsFromSellerNote(
    '✅ ADD-ONS REQUESTED:\n• Pet Hair Removal'
  ),
  ['Pet Hair Removal']
);

// Test 5 – Multiple add-ons in Square notes
assert(
  'Test 5: Square-only booking with multiple add-ons in notes',
  parseAddonsFromSellerNote(
    '✅ ADD-ONS REQUESTED:\n• Odor Eliminator\n• Ceramic Coating\n\n⚠️ Add-ons charged separately'
  ),
  ['Odor Eliminator', 'Ceramic Coating']
);

// ─── Group 3: Priority and deduplication ─────────────────────────────────────
console.log('\nGroup 3: Priority and deduplication');

// Test 6 – Structured add-ons take precedence (parser tests the note alone;
//           precedence in the UI is handled by the useEffect priority logic)
assert(
  'Test 6: Structured format parsed correctly (precedence is in caller)',
  parseAddonsFromSellerNote(
    'ADD-ONS (customer selected):\n• Odor Eliminator'
  ),
  ['Odor Eliminator']
);

// Test 7 – Duplicate add-ons are removed
assert(
  'Test 7: Duplicate add-ons are removed',
  parseAddonsFromSellerNote(
    'ADD-ONS (customer selected):\n• Odor Eliminator\n• Odor Eliminator\n• Disinfectant Service'
  ),
  ['Odor Eliminator', 'Disinfectant Service']
);

// ─── Group 4: Stop conditions ─────────────────────────────────────────────────
console.log('\nGroup 4: Stop conditions');

// Test 8 – Vehicle text is NOT parsed as an add-on
assert(
  'Test 8: Vehicle text is not parsed as an add-on',
  parseAddonsFromSellerNote(
    'ADD-ONS (customer selected):\n• Odor Eliminator\nVehicle: sedan'
  ),
  ['Odor Eliminator']
);

// Test 9 – CARD ON FILE text is NOT parsed as an add-on
assert(
  'Test 9: CARD ON FILE text is not parsed as an add-on',
  parseAddonsFromSellerNote(
    '🔒 CARD ON FILE: abc123\nADD-ONS (customer selected):\n• Odor Eliminator'
  ),
  ['Odor Eliminator']
);

// Test 10 – Payment instructions are NOT parsed as add-ons
assert(
  'Test 10: Payment instructions are not parsed as add-ons',
  parseAddonsFromSellerNote(
    'ADD-ONS (customer selected):\n• Odor Eliminator\nAdd-ons not charged today. Collect add-on payment at service time.'
  ),
  ['Odor Eliminator']
);

// ─── Group 5: Edge cases ─────────────────────────────────────────────────────
console.log('\nGroup 5: Edge cases');

// Test 11 – Unknown add-on names are preserved
assert(
  'Test 11: Unknown add-on names are preserved',
  parseAddonsFromSellerNote(
    'ADD-ONS (customer selected):\n• FutureAddon2099'
  ),
  ['FutureAddon2099']
);

// Test 12 – Empty / undefined input
assert(
  'Test 12: Existing jobs without add-ons return empty array (undefined input)',
  parseAddonsFromSellerNote(undefined),
  []
);

// Test 13 – Notes with no add-ons section
assert(
  'Test 13: Notes with no add-ons section return empty array',
  parseAddonsFromSellerNote('Interior Detail – Sedan/Coupe\nNaga Chaganti'),
  []
);

// Test 14 – Dash bullets supported
assert(
  'Test 14: Dash bullets are supported',
  parseAddonsFromSellerNote(
    'ADD-ONS (customer selected):\n- Odor Eliminator\n- Disinfectant Service'
  ),
  ['Odor Eliminator', 'Disinfectant Service']
);

// Test 15 – Add-ons do not appear when the list is empty (no heading present)
assert(
  'Test 15: Add-ons do not appear when list is empty (no heading)',
  parseAddonsFromSellerNote(
    'Just a normal note with no add-on heading'
  ),
  []
);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n── Results ────────────────────────────────────`);
console.log(`  Passed: ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error(`  Failed: ${failed}`);
  process.exit(1);
} else {
  console.log('  All tests passed ✓\n');
}
