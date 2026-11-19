# Offline fixtures for the trading tests

Real public-data samples (Yahoo Finance charts and feeds, SEC EDGAR, Nasdaq Trader symbol lists, the House Clerk
index) copied **unchanged** from the test fixtures of the Day Trader skill pack, commit
`3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd` (MIT licence, see `backend/trading/vendor/LICENSE`).
They let the tests run the vendored scripts with `--offline`, without any network access.
