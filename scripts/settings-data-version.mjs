// The format version of build/settings-data (toolkit/PHASE1.md D4): manifest, strings and
// tokens together. Both exporters write it to <out>/version; the native Settings refuses a
// directory whose version is not the one it was built for — a start-up error, never a silent
// fallback. Bump it with any change a reader of the old format would misread.
export const SETTINGS_DATA_VERSION = 1
