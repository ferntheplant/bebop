# Tests are layered by what they bring up, and unit tests are colocated

Tests are layered by what they start, not by where they live: unit tests stub nothing and sit beside their
source; component tests boot the real production layer stack; integration tests spawn real child processes;
artifact smokes run the packed bundles. [`docs/testing.md`](../testing.md) holds the full table and conventions.

A unit test constrains one source file, so colocating them keeps deletions and renames commuting naturally. A
component test constrains how an app's layers _compose_, which belongs to no single file — putting it beside one
of them would misrepresent what it covers.
