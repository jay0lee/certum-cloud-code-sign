/**
 * Test suite for SendKeys keystroke escaping.
 */

if (typeof console === 'undefined' && typeof print !== 'undefined') {
  globalThis.console = { log: print, error: print };
}

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message} -> expected "${expected}", got "${actual}"`);
    failed++;
  }
}

function escapeSendKeys(text) {
  return text.replace(/([+^%~(){}[\]])/g, '{$1}');
}

function escapePowerShell(script) {
  return script.replace(/'/g, "''");
}

console.log('Testing SendKeys escaping:');
assertEqual(escapeSendKeys('user@example.com'), 'user@example.com', 'Standard email left unmodified');
assertEqual(escapeSendKeys('123456'), '123456', 'Digits left unmodified');
assertEqual(escapeSendKeys('john+ci@example.com'), 'john{+}ci@example.com', 'Plus symbol escaped to {+}');
assertEqual(escapeSendKeys('pass%word^1~2(3)4{5}[6]'), 'pass{%}word{^}1{~}2{(}3{)}4{{}5{}}{[}6{]}', 'All special characters escaped');

console.log('\nTesting PowerShell string escaping:');
assertEqual(escapePowerShell("simple"), "simple", "Plain string unmodified");
assertEqual(escapePowerShell("user's password"), "user''s password", "Single quote doubled");

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
