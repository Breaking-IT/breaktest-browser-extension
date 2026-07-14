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

## Development

Keep the versions in both manifests aligned when releasing a recorder update.
After changing an unpacked Chromium extension, reload it on
`chrome://extensions` or `edge://extensions`. Firefox temporary add-ons can be
reloaded from `about:debugging#/runtime/this-firefox`.

The BreakTest repository pins this repository as its `browser-extension`
submodule so released BreakTest archives continue to include the recorder.

## Security and privacy

HAR recordings can contain credentials, cookies, authorization tokens,
personal data, and response content. Record only systems you are authorized to
test and review recordings before sharing them.

The recorder processes and exports data locally. It does not upload recordings
to a BreakTest service.

Please report suspected vulnerabilities privately according to
[SECURITY.md](SECURITY.md).

## License

BreakTest-owned source and documentation are provided under the
[BreakTest Community Source License 1.0](LICENSE).
