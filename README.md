# BreakTest Browser Recorder

Browser extensions for recording Chrome, Microsoft Edge, and Firefox sessions
as HAR files with named BreakTest transactions.

The recorder captures requests directly through the browser APIs; it does not
use an HTTP proxy. Recordings stay local and can be imported through
**File > Import HAR...** in [BreakTest](https://github.com/Breaking-IT/breaktest).

These are currently local developer extensions and are not yet published in
the browser extension stores.

## Install

- [Chrome and Microsoft Edge](chrome/README.md)
- [Firefox](firefox/README.md)

Clone this repository before following the browser-specific installation
guide:

```shell
git clone https://github.com/Breaking-IT/breaktest-browser-extension.git
```

Chrome and Chromium-based Edge use the same files from `chrome/`. Firefox has
a separate implementation in `firefox/` because its capture APIs differ from
Chromium's DevTools protocol.

During a recording, transactions can be renamed from the Transactions list.
When removing a transaction, its requests can be removed too or reassigned to
the previous or next transaction. The active transaction remains protected
until a newer transaction is started.

## Development

Keep the versions in both manifests aligned when releasing a recorder update.
After changing an unpacked Chromium extension, reload it on
`chrome://extensions` or `edge://extensions`. Firefox temporary add-ons can be
reloaded from `about:debugging#/runtime/this-firefox`.

The BreakTest repository pins this repository as its `browser-extension`
submodule so released BreakTest archives continue to include the recorder.

Validate both implementations and create the exact ZIP files accepted by the
browser stores:

```shell
python3 scripts/validate_extensions.py
python3 scripts/package_extensions.py
```

Packages and SHA-256 checksums are written to `dist/`. The Chromium package is
used for both Chrome and Microsoft Edge. Store listing copy, permission
justifications, and reviewer instructions are maintained under
`store-listing/`.

## Security and privacy

HAR recordings can contain credentials, cookies, authorization tokens,
personal data, and response content. Record only systems you are authorized to
test and review recordings before sharing them.

The recorder processes and exports data locally. It does not upload recordings
to a BreakTest service. The recording-data consent is remembered locally and
can be reviewed or revoked from **Privacy & settings** in the recorder. See the
full [privacy policy](PRIVACY.md).

Completed HARs are staged in browser-local IndexedDB so large exports do not
cross extension-message size limits. A staged export is removed after a
successful download or explicit discard; abandoned exports are eligible for
cleanup after 24 hours.

Please report suspected vulnerabilities privately according to
[SECURITY.md](SECURITY.md).

## License

BreakTest-owned source and documentation are provided under the
[BreakTest Community Source License 1.0](LICENSE).
