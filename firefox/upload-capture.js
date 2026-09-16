/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

/* Isolated-world capture: file contents are sent only to the extension background. */
(() => {
  if (globalThis.breaktestUploadCapture) {
    globalThis.breaktestUploadCapture.scan();
    return;
  }
  const api = globalThis.browser || globalThis.chrome;
  const seen = new WeakMap();

  async function capture(file, fieldName, source) {
    try {
      const status = await api.runtime.sendMessage({type: "upload-status"});
      if (!status?.ok || seen.get(file) === status.token) return;
      seen.set(file, status.token);
      const begin = await api.runtime.sendMessage({
        type: "upload-begin", token: status.token,
        file: {name: file.name || "blob", size: file.size, mimeType: file.type, fieldName, source}
      });
      if (!begin?.ok) return;
      const envelope = {token: status.token, id: begin.id};
      try {
        for (let offset = 0; offset < file.size; offset += begin.chunkBytes) {
          const bytes = new Uint8Array(await file.slice(offset, offset + begin.chunkBytes).arrayBuffer());
          let binary = "";
          for (let index = 0; index < bytes.length; index += 8192) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
          }
          const result = await api.runtime.sendMessage({type: "upload-chunk", ...envelope, data: btoa(binary)});
          if (!result?.ok) return;
        }
        await api.runtime.sendMessage({type: "upload-end", ...envelope});
      } catch (_error) {
        await api.runtime.sendMessage({type: "upload-end", ...envelope, failed: true});
      }
    } catch (_error) {
      // Extension reload, tab navigation, or a discarded recording ends capture.
    }
  }

  function inputFiles(input) {
    if (input?.type !== "file") return;
    for (const file of input.files || []) void capture(file, input.name || "", "input");
  }
  function scan(root = document) {
    for (const input of root.querySelectorAll('input[type="file"]')) inputFiles(input);
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) scan(element.shadowRoot);
    }
  }
  globalThis.breaktestUploadCapture = {scan};
  document.addEventListener("change", event => inputFiles(event.composedPath()[0]), true);
  document.addEventListener("drop", event => {
    for (const file of event.dataTransfer?.files || []) void capture(file, "", "drop");
  }, true);
  document.addEventListener("formdata", event => {
    for (const [name, value] of event.formData.entries()) {
      if (value instanceof Blob) void capture(value, name, "formdata");
    }
  }, true);
  scan();
})();
