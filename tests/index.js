/**
 * Entry for `node --test tests/`.
 *
 * Importing a test file registers its tests, so this file makes the whole suite
 * reachable through a directory argument as well as through the `npm test` glob
 * (`node --test "tests/*.test.mjs"`) and through a single file
 * (`node tests/report.test.mjs`).
 */
import "./report.test.mjs";
import "./watermark.test.mjs";
