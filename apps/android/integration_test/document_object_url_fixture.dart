// Keep the raw HTML and oracle JSON directly extractable by the Chrome runner.
// The native JS runtime does not implement HTMLImageElement load state or canvas
// APIs yet, so this shared fixture checks URL registry/fetch semantics and the
// DOM src attribute. The active preview URL remains registered for Flutter's
// real PNG rendering assertion.
const objectUrlHtml =
    r'''<!doctype html><html><head><meta charset="utf-8"><title>Blob URL parity</title>
<style>#blob-image { width: 32px; height: 32px; image-rendering: pixelated; }</style></head><body>
<h1>Blob URL parity</h1>
<button id="create-blob-previews" type="button">Create blob previews</button>
<img id="blob-image" width="32" height="32" alt="red one-pixel PNG">
<pre id="object-url-result">WAITING</pre>
<script>
(() => {
  const resultNode = document.querySelector('#object-url-result');
  const pngBytes = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0,
    13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0,
    1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
  ]);
  const bytesEqual = (actual, expected) => actual.length === expected.length &&
    actual.every((byte, index) => byte === expected[index]);
  const fetchSummary = async (target, init, expectedBytes) => {
    try {
      const response = await fetch(target, init);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        type: response.type,
        redirected: response.redirected,
        responseUrlMatches: response.url === target.split('#')[0],
        responseUrlHasFragment: response.url.includes('#'),
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        contentRange: response.headers.get('content-range'),
        bodyLength: bytes.length,
        bodyPrefix: Array.from(bytes.slice(0, 8)),
        bodyMatchesExpected: expectedBytes ? bytesEqual(Array.from(bytes), expectedBytes) : null
      };
    } catch (error) {
      return {ok: false, errorName: error.name};
    }
  };
  const fetchText = async target => {
    try {
      const response = await fetch(target);
      return {ok: true, status: response.status, text: await response.text()};
    } catch (error) {
      return {ok: false, errorName: error.name};
    }
  };
  const run = async () => {
    const blob = new Blob([pngBytes], {type: 'image/png'});
    const blobUrl = URL.createObjectURL(blob);
    const secondUrl = URL.createObjectURL(blob);
    const image = document.querySelector('#blob-image');
    image.src = blobUrl;

    const get = await fetchSummary(blobUrl, undefined, Array.from(pngBytes));
    const head = await fetchSummary(blobUrl, {method: 'HEAD'});
    const post = await fetchSummary(blobUrl, {method: 'POST', body: 'post-body'});
    const rangeFirst = await fetchSummary(blobUrl, {headers: {Range: 'bytes=0-9'}},
      Array.from(pngBytes.slice(0, 10)));
    const rangeSuffix = await fetchSummary(blobUrl, {headers: {Range: 'bytes=-4'}},
      Array.from(pngBytes.slice(-4)));
    const rangeUnsatisfiable = await fetchSummary(blobUrl, {headers: {Range: 'bytes=999-'}});
    const rangeMultiple = await fetchSummary(blobUrl, {headers: {Range: 'bytes=0-1,4-5'}});
    const rangeUnsupportedUnit = await fetchSummary(blobUrl, {headers: {Range: 'items=0-2'}});
    const withFragment = await fetchSummary(blobUrl + '#preview', undefined, Array.from(pngBytes));
    const withQuery = await fetchSummary(blobUrl + '?preview=1');
    const fragmentRevokeUrl = URL.createObjectURL(new Blob(['fragment'], {type: 'text/plain'}));
    URL.revokeObjectURL(fragmentRevokeUrl + '#preview');
    const fragmentRevokeKeepsBase = (await fetchText(fragmentRevokeUrl)).ok;
    URL.revokeObjectURL(fragmentRevokeUrl);

    const largeBytes = new Uint8Array(1024 * 1024).fill(42);
    const inFlightUrl = URL.createObjectURL(new Blob([largeBytes], {type: 'application/octet-stream'}));
    const inFlightPromise = fetch(inFlightUrl);
    URL.revokeObjectURL(inFlightUrl);
    let inFlight;
    try {
      const response = await inFlightPromise;
      const bytes = new Uint8Array(await response.arrayBuffer());
      inFlight = {
        ok: true,
        status: response.status,
        responseUrlMatches: response.url === inFlightUrl,
        bodyLength: bytes.length,
        firstByte: bytes[0]
      };
    } catch (error) {
      inFlight = {ok: false, errorName: error.name};
    }

    const revokeReturn = URL.revokeObjectURL(secondUrl);
    const afterRevoke = await fetchText(secondUrl);
    const result = {
      blob: {size: blob.size, type: blob.type, signature: Array.from(pngBytes.slice(0, 8))},
      urls: {
        hasExpectedBlobOriginPrefix: blobUrl.startsWith('blob:' + location.origin + '/'),
        nonemptyUrlSuffix: blobUrl.slice(('blob:' + location.origin + '/').length).length > 0,
        distinctUrlsForSameBlob: blobUrl !== secondUrl,
        getResponseUrlMatches: get.ok && get.responseUrlMatches,
        fragmentResponseUrlMatchesBase: withFragment.ok && withFragment.responseUrlMatches,
        queryRejected: !withQuery.ok,
        fragmentRevokeKeepsBase,
        revokeReturnIsUndefined: revokeReturn === undefined
      },
      fetch: {
        get, head, post,
        rangeFirst, rangeSuffix, rangeUnsatisfiable, rangeMultiple, rangeUnsupportedUnit,
        withFragment, withQuery, afterRevoke, inFlight
      },
      image: {
        srcHasBlob: image.src.startsWith('blob:'),
        attributeSame: image.getAttribute('src') === blobUrl
      }
    };
    resultNode.textContent = JSON.stringify(result);
  };
  document.querySelector('#create-blob-previews').addEventListener('click', () => {
    resultNode.textContent = 'RUNNING';
    run().catch(error => { resultNode.textContent = JSON.stringify({errorName: error.name, message: error.message}); });
  });
})();
</script></body></html>''';

// Dynamic UUIDs are normalized to stable booleans in the shared result.
const objectUrlExpectedJson = r'''{
  "blob": {
    "size": 70,
    "type": "image/png",
    "signature": [137, 80, 78, 71, 13, 10, 26, 10]
  },
  "urls": {
    "hasExpectedBlobOriginPrefix": true,
    "nonemptyUrlSuffix": true,
    "distinctUrlsForSameBlob": true,
    "getResponseUrlMatches": true,
    "fragmentResponseUrlMatchesBase": true,
    "queryRejected": true,
    "fragmentRevokeKeepsBase": true,
    "revokeReturnIsUndefined": true
  },
  "fetch": {
    "get": {
      "ok": true,
      "status": 200,
      "statusText": "OK",
      "type": "basic",
      "redirected": false,
      "responseUrlMatches": true,
      "responseUrlHasFragment": false,
      "contentType": "image/png",
      "contentLength": "70",
      "contentRange": null,
      "bodyLength": 70,
      "bodyPrefix": [137, 80, 78, 71, 13, 10, 26, 10],
      "bodyMatchesExpected": true
    },
    "head": {"ok": false, "errorName": "TypeError"},
    "post": {"ok": false, "errorName": "TypeError"},
    "rangeFirst": {
      "ok": true,
      "status": 206,
      "statusText": "OK",
      "type": "basic",
      "redirected": false,
      "responseUrlMatches": true,
      "responseUrlHasFragment": false,
      "contentType": "image/png",
      "contentLength": "10",
      "contentRange": "bytes 0-9/70",
      "bodyLength": 10,
      "bodyPrefix": [137, 80, 78, 71, 13, 10, 26, 10],
      "bodyMatchesExpected": true
    },
    "rangeSuffix": {
      "ok": true,
      "status": 206,
      "statusText": "OK",
      "type": "basic",
      "redirected": false,
      "responseUrlMatches": true,
      "responseUrlHasFragment": false,
      "contentType": "image/png",
      "contentLength": "4",
      "contentRange": "bytes 66-69/70",
      "bodyLength": 4,
      "bodyPrefix": [174, 66, 96, 130],
      "bodyMatchesExpected": true
    },
    "rangeUnsatisfiable": {"ok": false, "errorName": "TypeError"},
    "rangeMultiple": {"ok": false, "errorName": "TypeError"},
    "rangeUnsupportedUnit": {"ok": false, "errorName": "TypeError"},
    "withFragment": {
      "ok": true,
      "status": 200,
      "statusText": "OK",
      "type": "basic",
      "redirected": false,
      "responseUrlMatches": true,
      "responseUrlHasFragment": false,
      "contentType": "image/png",
      "contentLength": "70",
      "contentRange": null,
      "bodyLength": 70,
      "bodyPrefix": [137, 80, 78, 71, 13, 10, 26, 10],
      "bodyMatchesExpected": true
    },
    "withQuery": {"ok": false, "errorName": "TypeError"},
    "afterRevoke": {"ok": false, "errorName": "TypeError"},
    "inFlight": {
      "ok": true,
      "status": 200,
      "responseUrlMatches": true,
      "bodyLength": 1048576,
      "firstByte": 42
    }
  },
  "image": {"srcHasBlob": true, "attributeSame": true}
}''';
